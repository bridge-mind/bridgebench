/**
 * Abstract base class for all providers.
 *
 * Subclasses implement `stream()` which yields `StreamChunk` objects.
 * The runner consumes these uniformly regardless of the underlying API.
 */

import type { ProviderConfig, StreamChunk, StreamOptions } from './types.js';

export abstract class BaseProvider {
  abstract readonly name: string;
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /**
   * Stream a chat completion, yielding chunks as they arrive.
   * Each chunk may carry `content` (text delta), `inputTokens`,
   * and/or `outputTokens`.
   */
  abstract stream(options: StreamOptions): AsyncIterable<StreamChunk>;
}
