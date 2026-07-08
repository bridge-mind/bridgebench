/**
 * Anthropic provider.
 *
 * Uses the @anthropic-ai/sdk directly because Anthropic's Messages API
 * has a different shape from OpenAI's chat completions.
 */

import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';
import { getRunLogger } from './../logger.js';
import type { ProviderConfig, StreamChunk, StreamOptions } from './types.js';

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(config: ProviderConfig) {
    super(config);
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout ?? 120_000,
    });
  }

  async *stream(options: StreamOptions): AsyncIterable<StreamChunk> {
    const logger = getRunLogger();
    logger.debug('provider.http.request', {
      provider: this.name,
      body: {
        model: options.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        stream: true,
        messages: `[1 user message, ${options.prompt.length} chars]`,
      },
    });

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      messages: [{ role: 'user', content: options.prompt }],
      stream: true,
    });

    let stopReason: string | null = null;
    let finalOutputTokens: number | null = null;
    for await (const event of response) {
      switch (event.type) {
        case 'message_start':
          yield { inputTokens: event.message.usage.input_tokens };
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { content: event.delta.text };
          }
          break;

        case 'message_delta':
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
          finalOutputTokens = event.usage.output_tokens;
          yield { outputTokens: event.usage.output_tokens };
          break;
      }
    }

    logger.debug('provider.http.complete', {
      provider: this.name,
      mode: 'streaming',
      stopReason,
      outputTokens: finalOutputTokens,
    });
  }
}
