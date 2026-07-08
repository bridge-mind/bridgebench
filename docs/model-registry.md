# Model registry

`src/providers/models.ts` is the single source of truth for every model
BridgeBench knows about. One entry carries a model's **identity** (id, display
name, URL slug), **routing** (provider, API model override, aliases, variants),
**economics** (pricing), **capabilities** (reasoning, open weights), and
**lifecycle** (status, hidden). The CLI, runners, pricing, publish scripts, and
downstream consumers (bridgebench-ui, bridgebench-api) all derive model data
from here — nothing else should hardcode a model name.

## CLI

```bash
npm run models -- list                 # vendor-grouped table (add --all for hidden)
npm run models -- list -p openrouter   # filter by routing provider
npm run models -- list -v anthropic    # filter by model creator
npm run models -- show <id|slug|alias> # full entry + variants
npm run models -- validate             # every invariant; exit 1 on errors
npm run models -- export [-o file]     # JSON for downstream consumers
```

CI-friendly: `models validate` fails the build when an invariant breaks, and
`models export` refuses to emit an invalid registry.

## Entry anatomy

```ts
'openrouter/anthropic/claude-fable-5-july-1': {
  id: 'openrouter/anthropic/claude-fable-5-july-1',
  displayName: 'Claude Fable 5 July 1st',
  provider: 'openrouter',            // routing (PROVIDERS key in registry.ts)
  vendor: 'anthropic',               // who made the model, not who serves it
  family: 'claude-fable',            // coarse grouping for UI filters
  slug: 'claude-fable-5-july-1st',   // URL slug
  apiModel: 'anthropic/claude-fable-5', // what's actually sent to the API
  reasoning: 'optional',
  pricing: { input: 10, output: 50 },   // USD per 1M tokens
  tuning: { /* per-model request shaping — see below */ },
  notes: 'July 1st dated run of Claude Fable 5 via OpenRouter.',
},
```

### Identity & routing

| Field | Meaning |
|---|---|
| `id` | Canonical `provider/model` id. Registry key must equal it. |
| `provider` | Routing provider — must match the id prefix and a `PROVIDERS` key. |
| `vendor` | The lab that created the model (`anthropic` even when routed via `openrouter`). |
| `apiModel` | Override for the model name sent to the API (dated re-runs, `:thinking` variants). |
| `aliases` | Alternate ids that resolve here (legacy prefixes like `xai/grok-4`). Globally unique; never shadow a real id. |
| `variantOf` | Marks a re-run / alternate route / config variant of a canonical entry. Two entries may share a `slug` **only** via this link, and variants must point at a canonical entry (no chains). |
| `runnable: false` | Display-only entry with no provider adapter (e.g. `deepseek/deepseek-r1`). Everything else must have a runnable id prefix. |

`resolveModelId()` / `getModelEntry()` are alias-aware; `getModelBySlug()`
prefers the canonical entry when variants share a slug; `getCanonicalEntry()`
follows `variantOf`.

### Pricing

Pricing lives on the entry; `pricing.ts` is a thin adapter that keys the data
by full id **and** by API model name (what the runner passes), plus a frozen
`LEGACY_PRICING` table for pre-registry models. Semantics:

- `pricing: { input, output }` — static USD per 1M tokens
- `pricing: null` — intentionally none: the route reports actual cost
  per request (OpenRouter `StreamChunk.costUsd`) or the tier is free
- omitted — unknown; `models validate` warns until it's filled in

### Request tuning

`tuning` is per-model request shaping (reasoning config, streaming mode,
token ceiling, temperature). Resolution order in the UI runner:

1. the entry's `tuning` block — wins when present
2. family-wide pattern fallbacks in `tuneUiRequest()` (`z-ai/glm-*`,
   `google/gemini-*`, OpenRouter Kimi/Gemini/Anthropic-reasoning, …)

Keep family-wide rules in the fallbacks; put genuinely model-specific
overrides (dated runs, `:thinking` budgets) on the entry.

### Lifecycle & metadata

- `status`: `active` (default) · `preview` · `deprecated` · `retired`
- `hidden`: keep the entry (and its results) but suppress it from
  leaderboards/UI — the registry replaces per-site hidden-model lists
- `releaseDate`, `contextWindow`, `maxOutputTokens`: optional, fill in as
  verified — never guess
- `reasoning`: `none` · `optional` (hybrid) · `always` (reasoning tokens on
  every call)
- `openWeights`: true for open-weight models

## Invariants

`validateModelRegistry()` (run by `models validate` and `models.test.ts`)
enforces:

- registry key === `entry.id`; id prefix is a known provider unless
  `runnable: false`; `provider` matches the prefix
- kebab-case slugs; a shared slug has exactly one canonical entry and every
  other holder links to it via `variantOf`
- `variantOf` targets exist, are canonical, and never self-reference
- aliases are globally unique and never shadow real ids
- schema validity (Zod) for every field
- warning (not error) for runnable entries with no pricing information

## Adding a model

1. Add the entry under its vendor section in `src/providers/models.ts`
   (include `pricing`, or `pricing: null` for aggregator-reported routes).
2. If it's the same model as an existing entry via another route or date,
   link it with `variantOf` (share the slug for route variants).
3. `npm run models -- validate` (CI runs the same checks via vitest).
4. Done — CLI, runner, cost accounting, and exports pick it up.

Adding a **provider** is still a `PROVIDERS` entry in
`src/providers/registry.ts` (+ registry entries for its models).

## The JSON export — downstream contract

`npm run models -- export` emits a deterministic document (stable ordering,
no timestamps; identical registry → identical bytes):

```jsonc
{
  "schemaVersion": 1,
  "engine": { "version": "3.0.0-alpha.0" },
  "season": 1,
  "providers": [ { "slug", "name", "type", "kind", "baseURL?" } ],
  "models": [ {
    // ModelEntry with defaults resolved and harness-internal tuning stripped,
    // plus derived fields:
    "canonicalId": "…",   // variantOf target, or the id itself
    "artifactSlug": "…",  // matches artifact/publish URL slugs
    "status": "active", "hidden": false, "runnable": true, …
  } ]
}
```

Consumers:

- **bridgebench-ui** — `scripts/sync-to-ui.mjs` writes
  `src/data/model-registry.json` alongside the snapshot, replacing the
  hand-mirrored `MODEL_REGISTRY` in `src/data/model-utils.ts`.
- **bridgebench-api** — its append-only `models` / `model_providers` tables
  can be seeded by generating migration rows from this export instead of
  hand-writing SQL.

`RegistryExportSchema` (exported from `src/providers/models.ts`) is the
validation contract for anything that ingests the file.
