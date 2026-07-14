import OpenAI from 'openai';

import {
  ArenaCancellationError,
  isArenaCancellationError,
  throwIfCancelled,
} from './cancellation.js';
import { noopLogger, redactSecrets, type ArenaLogger } from './logger.js';
import { assertPromptSize, runOpenRouterAttempt } from './openrouter-transport.js';
import {
  JudgeVerdictSchema,
  type ChatRequest,
  type ModelCompletion,
  type ModelRegistryEntry,
  type OpenRouterGateway,
} from './types.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const RETRYABLE =
  /(?:429|rate.?limit|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|overloaded|5\d\d|premature close|invalid response body|socket hang up|other side closed|fetch failed|terminated|internal server error|bad gateway|service unavailable|gateway timeout|too many requests)/i;

export function isRetryableError(message: string): boolean {
  return RETRYABLE.test(message);
}

/**
 * Retryability decided structurally first, message text second. Provider
 * errors often surface with bare status text ("Internal Server Error") and
 * no digits — a 2026-07-14 OpenAI outage was classified permanent because
 * the message regex never saw a "5xx". SDK errors carry `status`; network
 * errors carry `code`; the regex remains the fallback for stream errors.
 */
export function isRetryableFailure(error: unknown, message: string): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && isRetryableError(code)) return true;
  return isRetryableError(message);
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).slice(0, 1_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new ArenaCancellationError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenRouterClient implements OpenRouterGateway {
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly logger: ArenaLogger;

  constructor(apiKey: string, logger: ArenaLogger = noopLogger) {
    if (!apiKey.trim()) throw new Error('OPENROUTER_API_KEY is required for arena runs');
    this.apiKey = apiKey;
    this.logger = logger;
    this.client = new OpenAI({
      apiKey,
      baseURL: BASE_URL,
      maxRetries: 0,
      // openai v4 defaults to its bundled node-fetch@2 transport, which fails
      // with "Premature close" on OpenRouter's chunked keepalive responses.
      // Node's native fetch handles them fine, so force it.
      fetch: globalThis.fetch as unknown as never,
      defaultHeaders: {
        'HTTP-Referer': 'https://bridgebench.ai',
        'X-OpenRouter-Title': 'BridgeBench V3 Arena',
      },
    });
  }

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    throwIfCancelled(request.signal);
    assertPromptSize(request);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfCancelled(request.signal);
      const startedAt = Date.now();
      const timeoutMs = request.model.request.timeoutMs;
      this.logger.debug('openrouter.request', {
        model: request.model.id,
        role: request.model.role,
        attempt,
        maxAttempts,
        timeoutMs,
        structured: Boolean(request.structured),
        reasoningEffort: request.model.request.reasoningEffort,
        maxTokens: request.model.request.maxTokens,
        systemChars: request.system.length,
        userChars: request.user.length,
      });
      // The SDK timeout option only bounds time-to-headers; a stream that goes
      // silent after headers would otherwise hang the run forever. This
      // watchdog aborts the whole attempt — connect and body — at the deadline.
      const timeoutController = new AbortController();
      const attemptSignal = request.signal
        ? AbortSignal.any([request.signal, timeoutController.signal])
        : timeoutController.signal;
      const watchdog = setTimeout(
        () =>
          timeoutController.abort(new Error(`OpenRouter request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      try {
        // Stream so bytes flow while the model reasons; a non-streaming request
        // sits silent for minutes and OpenRouter's edge closes the idle
        // connection ("Premature close") before the body arrives.
        const completion = await runOpenRouterAttempt(this.client, request, attempt, attemptSignal);
        this.logger.info('openrouter.completed', {
          model: request.model.id,
          role: request.model.role,
          generationId: completion.generationId,
          attempt,
          latencyMs: completion.latencyMs,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          reasoningTokens: completion.reasoningTokens ?? null,
          costUsd: completion.costUsd,
          finishReason: completion.finishReason,
          contentChars: completion.content.length,
        });
        if (completion.finishReason === 'length') {
          this.logger.warn('openrouter.truncated', {
            model: request.model.id,
            generationId: completion.generationId,
            maxTokens: request.model.request.maxTokens,
          });
        }
        if (
          !request.structured &&
          request.model.request.reasoningEffort !== 'low' &&
          !completion.reasoningTokens
        ) {
          // If the provider never reports hidden reasoning usage, the effort
          // parameter may be silently dropped; verify with `arena generation <id>`.
          this.logger.warn('openrouter.reasoning-unreported', {
            model: request.model.id,
            generationId: completion.generationId,
            reasoningEffort: request.model.request.reasoningEffort,
            latencyMs: completion.latencyMs,
            outputTokens: completion.outputTokens,
          });
        }
        return completion;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        if (request.signal?.aborted) {
          this.logger.info('openrouter.cancelled', {
            model: request.model.id,
            role: request.model.role,
            attempt,
            latencyMs,
          });
          throw new ArenaCancellationError();
        }
        if (isArenaCancellationError(error)) throw error;
        const message = timeoutController.signal.aborted
          ? `OpenRouter request timed out after ${timeoutMs}ms`
          : sanitizeError(error);
        const retryable = isRetryableFailure(error, message);
        if (attempt === maxAttempts || !retryable) {
          this.logger.error('openrouter.failed', {
            model: request.model.id,
            role: request.model.role,
            attempt,
            maxAttempts,
            latencyMs,
            retryable,
            error: message,
          });
          throw new Error(
            `${message} (model ${request.model.id}, attempt ${attempt}/${maxAttempts}, ${latencyMs}ms)`,
            { cause: error },
          );
        }
        const delayMs = attempt * 2_000;
        this.logger.warn('openrouter.retry', {
          model: request.model.id,
          role: request.model.role,
          attempt,
          maxAttempts,
          latencyMs,
          delayMs,
          error: message,
        });
        await sleep(delayMs, request.signal);
      } finally {
        clearTimeout(watchdog);
      }
    }

    throw new Error('OpenRouter request exhausted retries');
  }

  /**
   * Fetch OpenRouter's own record of a journaled generation. This is the
   * ground truth for native token counts, reasoning usage, provider routing,
   * and upstream latency — use it to verify what the stream reported.
   */
  async fetchGeneration(generationId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${BASE_URL}/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`Generation ${generationId} lookup failed with HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Record<string, unknown> };
    if (!body.data) throw new Error(`Generation ${generationId} lookup returned no data`);
    return body.data;
  }

  async validateModel(model: ModelRegistryEntry, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const timeoutMs = 30_000;
    const timeoutController = new AbortController();
    const validationSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const watchdog = setTimeout(
      () => timeoutController.abort(new Error(`Model validation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const response = await fetch(`${BASE_URL}/model/${model.id}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: validationSignal,
      });
      if (!response.ok)
        throw new Error(`Model ${model.id} validation failed with HTTP ${response.status}`);
      const body = (await response.json()) as {
        data?: { id?: string; canonical_slug?: string; supported_parameters?: string[] };
      };
      if (body.data?.id !== model.id) {
        throw new Error(
          `Model ${model.id} resolved to unexpected id ${body.data?.id ?? '<missing>'}`,
        );
      }
      if (body.data.canonical_slug !== model.canonicalSlug) {
        throw new Error(
          `Model ${model.id} canonical slug changed: expected ${model.canonicalSlug}, got ${body.data?.canonical_slug ?? '<missing>'}`,
        );
      }
      if (
        model.role === 'judge' &&
        !body.data.supported_parameters?.includes('structured_outputs')
      ) {
        throw new Error(`Judge ${model.id} no longer advertises structured_outputs`);
      }
    } catch (error) {
      if (signal?.aborted) throw new ArenaCancellationError();
      if (timeoutController.signal.aborted) {
        throw new Error(`Model ${model.id} validation timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(watchdog);
    }
  }
}

export function parseJudgeVerdict(content: string) {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JudgeVerdictSchema.parse(JSON.parse(trimmed));
}
