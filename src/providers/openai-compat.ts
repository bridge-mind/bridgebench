/**
 * OpenAI-compatible provider.
 *
 * Covers: OpenAI, Google (Gemini), xAI (Grok), MiniMax, Zhipu (GLM),
 * OpenRouter, and any future provider that exposes an OpenAI-shaped
 * chat completions endpoint.
 */

import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import { getRunLogger } from '../logger.js';
import type { ProviderConfig, StreamChunk, StreamOptions } from './types.js';

export interface OpenAICompatConfig extends ProviderConfig {
  baseURL: string;
  defaultHeaders?: Record<string, string>;
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Request usage data inside the stream (OpenAI extension). */
  streamUsage?: boolean;
  /** Some OpenAI-compatible providers only support non-streaming chat completions. */
  supportsStreaming?: boolean;
}

function isGpt55Model(model: string): boolean {
  return model === 'gpt-5.5' || model.endsWith('/gpt-5.5');
}

function normalizeOpenAICompatTemperature(model: string, temperature: number): number {
  if (isGpt55Model(model)) {
    return 1;
  }

  return temperature;
}

/**
 * OpenRouter occasionally prefixes JSON bodies with whitespace, which breaks
 * the OpenAI SDK's response parser ("Premature close"). Trim non-streaming
 * bodies only; SSE streams must pass through unchanged.
 */
function createOpenRouterFetch(): typeof fetch {
  return async (url, init) => {
    const res = await fetch(url, init);
    const body = init?.body;
    const isStream =
      typeof body === 'string' &&
      (() => {
        try {
          return JSON.parse(body).stream === true;
        } catch {
          return false;
        }
      })();

    if (isStream) {
      return res;
    }

    const text = await res.text();
    return new Response(text.trim(), {
      status: res.status,
      headers: res.headers,
    });
  };
}

export function buildOpenAICompatRequest(
  options: StreamOptions,
  config: Pick<OpenAICompatConfig, 'maxTokensParam' | 'streamUsage' | 'supportsStreaming'>,
): OpenAI.ChatCompletionCreateParams {
  const requestBody: OpenAI.ChatCompletionCreateParams & Record<string, unknown> = {
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    stream: config.supportsStreaming ?? true,
    temperature: normalizeOpenAICompatTemperature(options.model, options.temperature),
    ...(options.requestBodyOverrides ?? {}),
  };

  const maxTokensParam = config.maxTokensParam ?? 'max_tokens';
  if (maxTokensParam === 'max_completion_tokens') {
    (
      requestBody as OpenAI.ChatCompletionCreateParams & {
        max_completion_tokens?: number;
      }
    ).max_completion_tokens = options.maxTokens;
  } else {
    requestBody.max_tokens = options.maxTokens;
  }

  if (config.streamUsage) {
    requestBody.stream_options = { include_usage: true };
  }

  return requestBody;
}

export class OpenAICompatProvider extends BaseProvider {
  readonly name: string;
  private client: OpenAI;
  private maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  private streamUsage: boolean;
  private supportsStreaming: boolean;

  constructor(name: string, config: OpenAICompatConfig) {
    super(config);
    this.name = name;
    this.maxTokensParam = config.maxTokensParam ?? 'max_tokens';
    this.streamUsage = config.streamUsage ?? false;
    this.supportsStreaming = config.supportsStreaming ?? true;

    const isOpenRouter = config.baseURL.includes('openrouter.ai');

    // OpenAI SDK Fetch type is wider than Node's fetch; cast is intentional.
    const clientOptions = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
      timeout: config.timeout ?? 120_000,
      ...(isOpenRouter ? { fetch: createOpenRouterFetch() } : {}),
    };

    this.client = new OpenAI(clientOptions as ConstructorParameters<typeof OpenAI>[0]);
  }

  async *stream(options: StreamOptions): AsyncIterable<StreamChunk> {
    const logger = getRunLogger();
    const requestBody = buildOpenAICompatRequest(options, {
      maxTokensParam: this.maxTokensParam,
      streamUsage: this.streamUsage,
      supportsStreaming: this.supportsStreaming,
    });

    // The prompt itself is logged once by the runner; summarize it here so
    // the wire-level body is still fully reconstructable from the log.
    const { messages: _messages, ...bodyWithoutMessages } = requestBody;
    logger.debug('provider.http.request', {
      provider: this.name,
      body: { ...bodyWithoutMessages, messages: `[1 user message, ${options.prompt.length} chars]` },
    });

    if (!this.supportsStreaming || options.forceNonStreaming || isGpt55Model(options.model)) {
      const nonStreamingRequestBody = {
        ...requestBody,
        stream: false,
      };
      delete nonStreamingRequestBody.stream_options;
      const response = await this.client.chat.completions.create(
        nonStreamingRequestBody as OpenAI.ChatCompletionCreateParamsNonStreaming,
      ) as OpenAI.ChatCompletion;
      const message = response.choices[0]?.message as
        | (OpenAI.ChatCompletion.Choice['message'] & { reasoning_content?: string })
        | undefined;
      const content = message?.content ?? message?.reasoning_content;
      const usage = response.usage;

      logger.debug('provider.http.complete', {
        provider: this.name,
        mode: 'non-streaming',
        responseId: response.id,
        finishReason: response.choices[0]?.finish_reason ?? null,
        usedReasoningContentFallback: !message?.content && !!message?.reasoning_content,
        usage: usage ?? null,
      });

      yield {
        content: typeof content === 'string' ? content : undefined,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
      };
      return;
    }

    const stream = await this.client.chat.completions.create(
      requestBody as OpenAI.ChatCompletionCreateParamsStreaming,
    );

    let finishReason: string | null = null;
    let lastUsage: Record<string, unknown> | null = null;
    let reasoningContentChars = 0;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta as
        | (OpenAI.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string })
        | undefined;
      if (!delta?.content && delta?.reasoning_content) {
        reasoningContentChars += delta.reasoning_content.length;
      }
      const content = delta?.content ?? delta?.reasoning_content;
      const raw = chunk as unknown as Record<string, unknown>;
      const usage = raw.usage as
        | { prompt_tokens?: number; completion_tokens?: number; cost?: number }
        | undefined;
      if (usage) lastUsage = usage as Record<string, unknown>;

      // OpenRouter returns actual cost in usage.cost (USD) on the final chunk
      const costUsd = usage?.cost ?? (raw.x_openrouter as { cost?: number })?.cost;

      yield {
        content: content ?? undefined,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        ...(costUsd !== undefined && { costUsd: Number(costUsd) }),
      };
    }

    logger.debug('provider.http.complete', {
      provider: this.name,
      mode: 'streaming',
      finishReason,
      reasoningContentChars,
      usage: lastUsage,
    });
  }
}
