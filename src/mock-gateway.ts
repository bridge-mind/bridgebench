import { judgeVerdictJsonSchema } from './openrouter-transport.js';
import type {
  ChatRequest,
  ModelCompletion,
  ModelRegistryEntry,
  OpenRouterGateway,
} from './types.js';

export interface MockOpenRouterOptions {
  competitorText?: string;
  judgeWinner?: 'MODEL_A' | 'MODEL_B';
  chunkDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseCompletion(content: string, generationId: string): ModelCompletion {
  return {
    generationId,
    content,
    inputTokens: 120,
    outputTokens: Math.max(1, Math.ceil(content.length / 4)),
    costUsd: 0.02,
    latencyMs: 250,
    finishReason: 'stop',
    attempts: 1,
  };
}

export class MockOpenRouterGateway implements OpenRouterGateway {
  constructor(private readonly options: MockOpenRouterOptions = {}) {}

  async validateModel(_model: ModelRegistryEntry): Promise<void> {}

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    if (request.signal?.aborted) {
      throw new Error('Mock completion aborted');
    }

    if (request.structured) {
      const winner = this.options.judgeWinner ?? 'MODEL_A';
      const payload = {
        winner,
        confidence: 0.9,
        rationale: 'The selected mock response is better grounded.',
        criteria: {
          correctness: 'Correct.',
          grounding: 'Grounded.',
          constraintHandling: 'Complete.',
          completeness: 'Complete.',
        },
        violations: [],
      };
      void judgeVerdictJsonSchema();
      return baseCompletion(JSON.stringify(payload), `mock-judge-${request.model.id}`);
    }

    const variantA = [
      `The terminal state follows the cancellation edge before retry exhaustion.`,
      `The journal records a cancel-requested transition before the final attempt window closed, which rules out budget-stop and health-stop.`,
      `The discriminating evidence is the cancellation timestamp preceding the last retry.`,
    ];
    const variantB = [
      `Working backwards from the final journal entry, the run ends on the cancellation path rather than retry exhaustion.`,
      `Spend stayed below the budget threshold and no health probes failed in the window, so those edges are excluded.`,
      `The single strongest signal is the cancel-requested event landing before the retry counter reached its limit.`,
    ];
    const checksum = [...request.model.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const text =
      this.options.competitorText ?? (checksum % 2 === 0 ? variantA : variantB).join(' ');
    const delayMs =
      Number(process.env.MOCK_CHUNK_DELAY_MS ?? '') || this.options.chunkDelayMs || 40;
    const parts = text.match(/.{1,24}/g) ?? [text];
    let cumulative = '';
    for (const part of parts) {
      if (request.signal?.aborted) {
        throw new Error('Mock completion aborted');
      }
      cumulative += part;
      request.onDelta?.(cumulative);
      if (delayMs > 0) await sleep(delayMs);
    }
    return baseCompletion(cumulative, `mock-competitor-${request.model.id}`);
  }
}
