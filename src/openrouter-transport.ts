import type OpenAI from 'openai';

import { JUDGE_VERDICT_TRANSPORT_SCHEMA, type ChatRequest, type ModelCompletion } from './types.js';

export const MAX_PROMPT_CHARS = 180_000;

interface StreamChunk {
  id?: string;
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
    cost?: number;
  } | null;
}

export function assertPromptSize(request: ChatRequest): void {
  if (request.system.length + request.user.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt exceeds ${MAX_PROMPT_CHARS} character safety limit`);
  }
}

export function judgeVerdictJsonSchema(): Record<string, unknown> {
  return JUDGE_VERDICT_TRANSPORT_SCHEMA;
}

function judgeResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'bridgebench_judge_verdict',
      strict: true,
      schema: judgeVerdictJsonSchema(),
    },
  };
}

function buildRequest(request: ChatRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: request.model.request.temperature,
    max_tokens: request.model.request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    // OpenRouter extensions stay inside this transport adapter.
    usage: { include: true },
    reasoning: {
      effort: request.model.request.reasoningEffort,
      exclude: request.model.request.excludeReasoning,
    },
    ...(request.structured ? { response_format: judgeResponseFormat() } : {}),
  };
}

async function consumeStream(
  stream: AsyncIterable<StreamChunk>,
  request: ChatRequest,
  startedAt: number,
  attempt: number,
): Promise<ModelCompletion> {
  let generationId = '';
  let content = '';
  let finishReason: string | null = null;
  let usage: NonNullable<StreamChunk['usage']> = {};
  let lastDeltaEmit = 0;
  // Time-to-first-token: stamped on the first non-empty content delta, before
  // (and independent of) the throttle that governs onDelta emission.
  let firstTokenAt = 0;

  for await (const chunk of stream) {
    if (chunk.id) generationId ||= chunk.id;
    const delta = chunk.choices?.[0]?.delta?.content ?? '';
    if (delta && firstTokenAt === 0) firstTokenAt = Date.now();
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

  const completedAt = Date.now();
  return {
    generationId,
    content,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details
      ? (usage.completion_tokens_details.reasoning_tokens ?? 0)
      : undefined,
    costUsd: usage.cost ?? 0,
    latencyMs: completedAt - startedAt,
    finishReason: finishReason ?? 'unknown',
    attempts: attempt,
    // Non-empty content above guarantees firstTokenAt was stamped.
    ttftMs: firstTokenAt - startedAt,
    totalMs: completedAt - startedAt,
  };
}

export async function runOpenRouterAttempt(
  client: OpenAI,
  request: ChatRequest,
  attempt: number,
  signal: AbortSignal,
): Promise<ModelCompletion> {
  const startedAt = Date.now();
  const stream = await client.chat.completions.create(buildRequest(request) as never, {
    timeout: request.model.request.timeoutMs,
    signal,
  });
  return consumeStream(
    stream as unknown as AsyncIterable<StreamChunk>,
    request,
    startedAt,
    attempt,
  );
}
