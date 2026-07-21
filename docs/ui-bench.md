# UI Bench

UI Bench is BridgeBench's other benchmark: instead of code review by a judge
model, a competitor writes one self-contained HTML file — pinned Three.js,
no external assets — for a creative-rendering task. Live runs validate and
publish that artifact directly for community A/B voting; they never mix into
arena Elo (see [Arena](glossary.md#arena)). An explicit offline evaluation
command remains available for browser diagnostics.

The full Season 1 engine (ten tasks, provider-agnostic live-model runner,
hidden interaction probes) shipped on the
[`season-engine-alpha` branch](https://github.com/bridge-mind/bridgebench/tree/season-engine-alpha)
before this repository's `main` was rebuilt as a pure code-generation arena.
`main` currently carries one restored task — the lava lamp
(`s1-lava-lamp-redux`), UI Bench's signature task — as a working slice of
that engine, kept deliberately separate from the arena's category/task
system (`src/contracts/categories.ts`, `src/tasks.ts`). The live-model
runner (`bridgebench ui run`) is ported and runs against OpenRouter; the
other nine tasks remain on `season-engine-alpha`.

## Live qualification vs. offline diagnostics

An artifact has two independent validation layers:

- **Live qualification** — objective static pass/fail: is the response one
  self-contained HTML document with the pinned import map, allowed module
  imports, and both harness globals
  (`window.BridgeBenchTaskManifest` / `window.BridgeBenchTaskApi`)? This is the
  gate used by `bridgebench ui run`; no browser is launched.
- **Offline evaluation** — `bridgebench ui evaluate` can render a saved
  artifact in Chromium to diagnose startup errors, blank frames, unexpected
  network attempts, motion, controls, WebGL, and determinism. This is separate
  from live generation and database publishing.
- **Probes** — hidden interaction checks (does the heat slider actually
  change the animation rate, does the palette button shift hue) that live in
  a separate private repo, `bridgebench-private`, and are diagnostic only —
  they never gate qualification. Without `BRIDGEBENCH_PRIVATE_DIR` set,
  probe results are reported as partial.

## Try it

```bash
npm run ui -- tasks                                          # list + validate task specs
npm run ui -- evaluate fixtures/golden-correct.html \
  -t s1-lava-lamp-redux                                       # QUALIFIED
npm run ui -- evaluate fixtures/golden-broken.html \
  -t s1-lava-lamp-redux                                       # DISQUALIFIED
```

`fixtures/golden-correct.html` is a minimal reference artifact that
satisfies the lava lamp's contract end to end (harness globals, both
`data-bb-control` targets, deterministic seeded reset, WebGL rendering) —
`fixtures/golden-broken.html` and `fixtures/golden-cheating.html` are
negative fixtures for the disqualification and static-validation paths.
`npm test` runs all three through the full pipeline in
`test/ui-evaluator.integration.test.ts`, real Chromium included.

## Run live models

`bridgebench ui run` streams an artifact from each requested model (any
OpenRouter slug — `OPENROUTER_API_KEY` required), validates its static
contract, and journals the outcome with real token/cost/latency numbers. It
does not launch Chromium:

```bash
npm run ui -- run -m anthropic/claude-opus-4.8,openai/gpt-5.6-sol \
  -t s1-lava-lamp-redux                                # journal only
npm run ui -- run -m acme/new-model --publish \
  --run-key ui-s1-20260715                             # stream results live
npm run ui -- run -m reference --mock                  # golden-fixture pipeline test
```

`--publish` sends each completed streamed result to the API immediately (one
POST per result under a run key chosen at start; failures are re-swept
idempotently at run end). `--mock` feeds `fixtures/golden-correct.html`
through the same extract → validate → journal pipeline with zero spend and
never publishes; mock journals live under `results/ui-mock/`. `--resume`
skips (model, task) pairs already successful in the journal. `--dry` remains
as a deprecated no-op for CLI compatibility. `--max-tokens` and
`--temperature` override the UI request policy (32k tokens, temperature 0.7,
reasoning excluded). SIGINT cancels the in-flight provider stream and exits
130 after preserving completed results.

## Publish results to the API

`ui evaluate --journal` appends the outcome (qualification, validation,
evaluation diagnostics, artifact sha256) to the local journal at
`results/ui/journal.jsonl` and copies the evaluated artifact plus its gallery
screenshots to `results/ui/artifacts/<taskId>/<modelSlug>/`; `-m/--model`
names the model the result is credited to. `ui publish` then pushes the
journal to the configured API with the artifact HTML and screenshot bytes
inlined:

```bash
npm run ui -- evaluate fixtures/golden-correct.html \
  -t s1-lava-lamp-redux -m reference --journal
npm run ui -- publish                                # needs BRIDGEBENCH_API_URL + BRIDGEBENCH_ADMIN_KEY
```

The local journal is the execution authority; the API
(`POST /ui-bench/results/import`, admin-key guarded) stores a one-way
published replica keyed by run — `--run-key` overrides the default
`ui-s<season>-<yyyymmdd>` identity. Imports are idempotent: re-publishing an
unchanged journal reports every result as skipped, while changed content for
an already-published `(run, task, model)` is rejected as a conflict, so
re-evaluated results belong under a fresh `--run-key`.

## Task spec

Public task YAML lives at `tasks/current/ui/<id>.yaml` — season-prefixed id,
title, category, viewport, pinned library versions, the public control
contract, screenshot capture points, and the creative prompt. Public files
must never contain a `probes:` key (the loader rejects them); hidden probes
are authored separately as `bridgebench-private/tasks/current/ui/<id>.probes.yaml`.
The full authoring contract (including the probe DSL) is documented in
[`season-engine-alpha`'s `docs/task-authoring.md`](https://github.com/bridge-mind/bridgebench/blob/season-engine-alpha/docs/task-authoring.md).
