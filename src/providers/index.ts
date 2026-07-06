/**
 * Provider abstraction layer.
 *
 * Re-exports everything needed by the runner and CLI so consumers
 * import from `./providers/index.js` rather than individual files.
 */

// Base class & concrete providers
export { BaseProvider } from './base.js';
export { OpenAICompatProvider } from './openai-compat.js';
export type { OpenAICompatConfig } from './openai-compat.js';
export { AnthropicProvider } from './anthropic.js';

// Registry — provider definitions, parsing, factory
export {
  PROVIDERS,
  createProvider,
  listProviders,
  parseModelId,
} from './registry.js';

// Pricing
export { calculateCost, hasPricing } from './pricing.js';

// Model registry — canonical display names, slugs, and metadata
export {
  MODEL_REGISTRY,
  getDisplayName,
  getModelSlug,
  getModelBySlug,
  getModelEntry,
  slugify,
} from './models.js';
export type { ModelEntry } from './models.js';

// Reasoning tuning
export { resolveReasoningTuning } from './reasoning-tuning.js';
export type { ReasoningTuning } from './reasoning-tuning.js';

// Types
export type {
  ProviderConfig,
  ProviderDefinition,
  StreamChunk,
  StreamOptions,
} from './types.js';
