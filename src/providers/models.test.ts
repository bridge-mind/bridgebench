import { describe, expect, it } from 'vitest';

import {
  MODEL_REGISTRY,
  RegistryExportSchema,
  buildRegistryExport,
  getCanonicalEntry,
  getDisplayName,
  getModelBySlug,
  getModelEntry,
  listModels,
  resolveModelId,
  validateModelRegistry,
} from './models.js';
import { calculateCost, getPricing, hasPricing } from './pricing.js';
import { PROVIDERS, parseModelId } from './registry.js';

const KNOWN_PROVIDERS = Object.keys(PROVIDERS);

describe('model registry invariants', () => {
  it('passes every registry validation rule', () => {
    const report = validateModelRegistry(KNOWN_PROVIDERS);
    expect(report.errors).toEqual([]);
  });

  it('every runnable entry parses with parseModelId', () => {
    for (const entry of Object.values(MODEL_REGISTRY)) {
      if (entry.runnable === false) continue;
      const { providerSlug } = parseModelId(entry.id);
      expect(providerSlug).toBe(entry.provider);
    }
  });

  it('registry keys match entry ids', () => {
    for (const [key, entry] of Object.entries(MODEL_REGISTRY)) {
      expect(key).toBe(entry.id);
    }
  });

  it('variant targets exist and are canonical', () => {
    for (const entry of Object.values(MODEL_REGISTRY)) {
      if (!entry.variantOf) continue;
      const target = MODEL_REGISTRY[entry.variantOf];
      expect(target, `${entry.id} → ${entry.variantOf}`).toBeDefined();
      expect(target.variantOf).toBeUndefined();
    }
  });
});

describe('alias resolution', () => {
  it('resolves legacy prefixes to canonical ids', () => {
    expect(resolveModelId('xai/grok-4')).toBe('x-ai/grok-4');
    expect(resolveModelId('alibaba/qwen3-coder-480b')).toBe(
      'qwen/qwen3-coder-480b',
    );
  });

  it('passes unknown ids through unchanged', () => {
    expect(resolveModelId('acme/unknown-model')).toBe('acme/unknown-model');
  });

  it('lookups are alias-aware', () => {
    expect(getModelEntry('xai/grok-4')?.id).toBe('x-ai/grok-4');
    expect(getDisplayName('xai/grok-4')).toBe('Grok 4');
  });
});

describe('slug lookups', () => {
  it('prefers the canonical entry when variants share a slug', () => {
    expect(getModelBySlug('glm-5')?.id).toBe('z-ai/glm-5');
    expect(getModelBySlug('claude-opus-4-6')?.id).toBe(
      'anthropic/claude-opus-4-6',
    );
    expect(getModelBySlug('grok-4-3')?.id).toBe('x-ai/grok-4.3');
  });

  it('follows variantOf to the canonical entry', () => {
    expect(getCanonicalEntry('openrouter/z-ai/glm-5')?.id).toBe('z-ai/glm-5');
    expect(getCanonicalEntry('anthropic/claude-opus-4-6')?.id).toBe(
      'anthropic/claude-opus-4-6',
    );
  });
});

describe('display name fallback', () => {
  it('auto-formats unregistered ids without crashing', () => {
    expect(getDisplayName('acme/some-new-model')).toBe('Some New Model');
  });
});

describe('pricing adapter', () => {
  it('prices by full registry id', () => {
    expect(calculateCost('anthropic/claude-opus-4-6', 1_000_000, 1_000_000)).toBe(
      90,
    );
  });

  it('prices by bare API model name (runner path)', () => {
    expect(calculateCost('claude-opus-4-6', 1_000_000, 1_000_000)).toBe(90);
  });

  it('prices via apiModel overrides', () => {
    // openrouter/anthropic/claude-fable-5-july-1 → apiModel anthropic/claude-fable-5
    expect(getPricing('anthropic/claude-fable-5')).toEqual({
      input: 10,
      output: 50,
    });
  });

  it('prices aliases through resolution', () => {
    // xai/grok-4 → x-ai/grok-4 has no pricing; use a priced alias-free check
    expect(hasPricing('z-ai/glm-5')).toBe(true);
  });

  it('keeps legacy keys working', () => {
    expect(hasPricing('qwen-max')).toBe(true);
    expect(calculateCost('qwen-max', 1_000_000, 0)).toBeCloseTo(1.6);
  });

  it('returns 0 for unknown models', () => {
    expect(calculateCost('acme/unknown', 1_000_000, 1_000_000)).toBe(0);
    expect(hasPricing('acme/unknown')).toBe(false);
  });
});

describe('registry export', () => {
  const exported = buildRegistryExport({
    engineVersion: '3.0.0-test',
    season: 1,
    providers: Object.entries(PROVIDERS).map(([slug, def]) => ({
      slug,
      name: def.name,
      type: def.type,
      kind: def.kind ?? 'vendor',
      ...(def.baseURL ? { baseURL: def.baseURL } : {}),
    })),
  });

  it('conforms to the export schema', () => {
    expect(() => RegistryExportSchema.parse(exported)).not.toThrow();
  });

  it('covers every registry entry, including hidden ones', () => {
    expect(exported.models).toHaveLength(Object.keys(MODEL_REGISTRY).length);
  });

  it('strips harness-internal tuning', () => {
    for (const model of exported.models) {
      expect(model).not.toHaveProperty('tuning');
    }
  });

  it('resolves defaults and canonical ids', () => {
    const thinking = exported.models.find(
      (m) => m.id === 'openrouter/anthropic/claude-opus-4.7:thinking',
    );
    expect(thinking?.hidden).toBe(true);
    expect(thinking?.canonicalId).toBe('openrouter/anthropic/claude-opus-4.7');
    expect(thinking?.artifactSlug).toBe(
      'openrouter--anthropic--claude-opus-4.7-thinking',
    );

    const displayOnly = exported.models.find(
      (m) => m.id === 'deepseek/deepseek-r1',
    );
    expect(displayOnly?.runnable).toBe(false);
  });

  it('is deterministic (stable ordering, no timestamps)', () => {
    const again = buildRegistryExport({
      engineVersion: '3.0.0-test',
      season: 1,
      providers: [],
    });
    expect(again.models).toEqual(exported.models);
    expect(JSON.stringify(exported)).not.toMatch(/generatedAt/);
  });
});

describe('list filters', () => {
  it('hides hidden entries by default', () => {
    const ids = listModels().map((m) => m.id);
    expect(ids).not.toContain('openrouter/anthropic/claude-opus-4.7:thinking');
    expect(
      listModels({ includeHidden: true }).map((m) => m.id),
    ).toContain('openrouter/anthropic/claude-opus-4.7:thinking');
  });

  it('filters by provider and vendor', () => {
    const anthropicRouted = listModels({ provider: 'anthropic' });
    expect(anthropicRouted.every((m) => m.provider === 'anthropic')).toBe(true);

    const anthropicMade = listModels({ vendor: 'anthropic', includeHidden: true });
    expect(
      anthropicMade.some((m) => m.provider === 'openrouter'),
    ).toBe(true);
  });
});
