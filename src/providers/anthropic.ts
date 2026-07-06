/**
 * Anthropic provider.
 *
 * Uses the @anthropic-ai/sdk directly because Anthropic's Messages API
 * has a different shape from OpenAI's chat completions.
 */

import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';
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
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      messages: [{ role: 'user', content: options.prompt }],
      stream: true,
    });

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
          yield { outputTokens: event.usage.output_tokens };
          break;
      }
    }
  }
}
