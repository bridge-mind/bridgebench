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
export { calculateCost, getPricing, hasPricing } from './pricing.js';

// Model registry — canonical identity, metadata, pricing, tuning, exports
export {
  MODEL_REGISTRY,
  ModelEntrySchema,
  ModelPricingSchema,
  ModelRequestTuningSchema,
  RegistryExportSchema,
  artifactSlug,
  buildRegistryExport,
  getCanonicalEntry,
  getDisplayName,
  getModelBySlug,
  getModelEntry,
  getModelSlug,
  listModels,
  resolveModelId,
  slugify,
  validateModelRegistry,
} from './models.js';
export type {
  ExportedModel,
  ListModelsFilter,
  ModelEntry,
  ModelPricing,
  ModelRequestTuning,
  ModelStatus,
  ReasoningSupport,
  RegistryExport,
  RegistryExportMeta,
  RegistryExportProvider,
  RegistryValidationReport,
} from './models.js';

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
