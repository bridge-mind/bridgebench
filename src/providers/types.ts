/**
 * Provider abstraction types.
 *
 * Every provider — whether OpenAI-compatible or not — emits a uniform
 * stream of `StreamChunk` objects so the runner can measure TPS / TTFT
 * without caring about the underlying API.
 */

// ---------------------------------------------------------------------------
// Stream chunk — the universal unit yielded by every provider
// ---------------------------------------------------------------------------

export interface StreamChunk {
  /** Text content delta (may be undefined for usage-only chunks) */
  content?: string;
  /** Prompt / input token count (usually arrives once) */
  inputTokens?: number;
  /** Completion / output token count (usually arrives in final chunk) */
  outputTokens?: number;
  /** Provider-reported cost in USD (e.g. OpenRouter returns actual cost) */
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Options passed to provider.stream()
// ---------------------------------------------------------------------------

export interface StreamOptions {
  /** Model ID to send to the API (provider prefix already stripped) */
  model: string;
  /** The user prompt */
  prompt: string;
  /** Max tokens to generate */
  maxTokens: number;
  /** Sampling temperature */
  temperature: number;
  /** Optional provider-specific request fields. */
  requestBodyOverrides?: Record<string, unknown>;
  /** Force a one-shot completion even when the provider supports streaming. */
  forceNonStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Provider definition in the registry
// ---------------------------------------------------------------------------

export interface ProviderDefinition {
  /** Human-readable name, e.g. "OpenAI" */
  name: string;
  /**
   * Whether this is the model's own lab ("vendor") or a routing layer
   * ("aggregator", e.g. OpenRouter). Default: "vendor".
   */
  kind?: 'vendor' | 'aggregator';
  /** Environment variable that holds the API key */
  envKey: string;
  /** Accepted environment variable aliases */
  envAliases?: string[];
  /** Provider type — determines which class to instantiate */
  type: 'openai-compat' | 'anthropic';
  /** Base URL for OpenAI-compatible providers */
  baseURL?: string;
  /** Extra headers (e.g. OpenRouter referer) */
  defaultHeaders?: Record<string, string>;
  /** Provider-specific token limit field */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /**
   * Whether to send `stream_options: { include_usage: true }`.
   * Safe for OpenAI & xAI; some providers ignore or reject it.
   * Default: false
   */
  streamUsage?: boolean;
  /**
   * Whether the provider supports SSE chat streaming.
   * Default: true
   */
  supportsStreaming?: boolean;
  /**
   * Request timeout in milliseconds.
   * Default: 120_000 (2 minutes)
   */
  timeout?: number;
}
