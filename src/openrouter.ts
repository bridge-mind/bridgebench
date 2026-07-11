import OpenAI from 'openai';

import { noopLogger, redactSecrets, type ArenaLogger } from './logger.js';
import { JudgeVerdictSchema, type ChatRequest, type ModelCompletion, type ModelRegistryEntry, type OpenRouterGateway } from './types.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_PROMPT_CHARS = 180_000;
const RETRYABLE = /(?:429|rate.?limit|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|overloaded|5\d\d|premature close|invalid response body|socket hang up|other side closed|fetch failed|terminated)/i;

export function isRetryableError(message: string): boolean {
  return RETRYABLE.test(message);
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).slice(0, 1_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPromptSize(request: ChatRequest): void {
  if (request.system.length + request.user.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt exceeds ${MAX_PROMPT_CHARS} character safety limit`);
  }
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
    assertPromptSize(request);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Stream so bytes flow while the model reasons; a non-streaming request
        // sits silent for minutes and OpenRouter's edge closes the idle
        // connection ("Premature close") before the body arrives.
        const stream = await this.client.chat.completions.create(
          {
            model: request.model.id,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            temperature: request.model.request.temperature,
            max_tokens: request.model.request.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            usage: { include: true },
            reasoning: {
              effort: request.model.request.reasoningEffort,
              exclude: request.model.request.excludeReasoning,
            },
            ...(request.structured
              ? {
                  response_format: {
                    type: 'json_schema',
                    json_schema: {
                      name: 'bridgebench_judge_verdict',
                      strict: true,
                      schema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['winner', 'confidence', 'rationale', 'criteria', 'violations'],
                        properties: {
                          winner: { type: 'string', enum: ['MODEL_A', 'MODEL_B'] },
                          confidence: { type: 'number', minimum: 0, maximum: 1 },
                          rationale: { type: 'string' },
                          criteria: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['correctness', 'grounding', 'constraintHandling', 'completeness'],
                            properties: {
                              correctness: { type: 'string' },
                              grounding: { type: 'string' },
                              constraintHandling: { type: 'string' },
                              completeness: { type: 'string' },
                            },
                          },
                          violations: { type: 'array', items: { type: 'string' } },
                        },
                      },
                    },
                  },
                }
              : {}),
          } as never,
          { timeout: timeoutMs, signal: controller.signal },
        );

        type StreamChunk = {
          id?: string;
          choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number } | null;
            cost?: number;
          } | null;
        };
        const chunks = stream as unknown as AsyncIterable<StreamChunk>;
        let generationId = '';
        let content = '';
        let finishReason: string | null = null;
        let usage: NonNullable<StreamChunk['usage']> = {};
        let lastDeltaEmit = 0;

        for await (const chunk of chunks) {
          if (chunk.id) generationId ||= chunk.id;
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          content += delta;
          finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
          if (chunk.usage) usage = chunk.usage;
          if (delta && request.onDelta && Date.now() - lastDeltaEmit >= 500) {
            lastDeltaEmit = Date.now();
            request.onDelta(content);
          }
        }

        content = content.trim();
        if (!content) throw new Error('OpenRouter returned an empty completion');

        const completion: ModelCompletion = {
          generationId,
          content,
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          reasoningTokens: usage.completion_tokens_details
            ? usage.completion_tokens_details.reasoning_tokens ?? 0
            : undefined,
          costUsd: usage.cost ?? 0,
          latencyMs: Date.now() - startedAt,
          finishReason: finishReason ?? 'unknown',
          attempts: attempt,
        };
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
        if (!request.structured && request.model.request.reasoningEffort !== 'low' && !completion.reasoningTokens) {
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
        const message = controller.signal.aborted
          ? `OpenRouter request timed out after ${timeoutMs}ms`
          : sanitizeError(error);
        if (attempt === maxAttempts || !RETRYABLE.test(message)) {
          this.logger.error('openrouter.failed', {
            model: request.model.id,
            role: request.model.role,
            attempt,
            maxAttempts,
            latencyMs,
            retryable: RETRYABLE.test(message),
            error: message,
          });
          throw new Error(`${message} (model ${request.model.id}, attempt ${attempt}/${maxAttempts}, ${latencyMs}ms)`);
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
        await sleep(delayMs);
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
    if (!response.ok) throw new Error(`Generation ${generationId} lookup failed with HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Record<string, unknown> };
    if (!body.data) throw new Error(`Generation ${generationId} lookup returned no data`);
    return body.data;
  }

  async validateModel(model: ModelRegistryEntry): Promise<void> {
    const response = await fetch(`${BASE_URL}/model/${model.id}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Model ${model.id} validation failed with HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: { id?: string; canonical_slug?: string; supported_parameters?: string[] };
    };
    if (body.data?.id !== model.id) {
      throw new Error(`Model ${model.id} resolved to unexpected id ${body.data?.id ?? '<missing>'}`);
    }
    if (body.data.canonical_slug !== model.canonicalSlug) {
      throw new Error(
        `Model ${model.id} canonical slug changed: expected ${model.canonicalSlug}, got ${body.data?.canonical_slug ?? '<missing>'}`,
      );
    }
    if (model.role === 'judge' && !body.data.supported_parameters?.includes('structured_outputs')) {
      throw new Error(`Judge ${model.id} no longer advertises structured_outputs`);
    }
  }
}

export function parseJudgeVerdict(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JudgeVerdictSchema.parse(JSON.parse(trimmed));
}
