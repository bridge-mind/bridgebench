# UI Bench

UI Bench is BridgeBench's other benchmark: instead of code review by a judge
model, a competitor writes one self-contained HTML file — pinned Three.js,
no external assets — for a creative-rendering task, and a headless-browser
harness scores what actually renders. Results are diagnostic and community
A/B voted; they never mix into arena Elo (see [Arena](glossary.md#arena)).

The full Season 1 engine (ten tasks, provider-agnostic live-model runner,
hidden interaction probes) shipped on the
[`season-engine-alpha` branch](https://github.com/bridge-mind/bridgebench/tree/season-engine-alpha)
before this repository's `main` was rebuilt as a pure code-generation arena.
`main` currently carries one restored task — the lava lamp
(`s1-lava-lamp-redux`), UI Bench's signature task — as a working slice of
that engine, kept deliberately separate from the arena's category/task
system (`src/contracts/categories.ts`, `src/tasks.ts`). The other nine tasks
and the live-model runner (`bridgebench ui run`) remain on
`season-engine-alpha` and haven't been ported yet.

## Qualification vs. probes

An artifact's evaluation has two independent layers:

- **Qualification** — objective, harness-only pass/fail: did the page load,
  render a non-blank first frame, expose the harness contract
  (`window.BridgeBenchTaskManifest` / `window.BridgeBenchTaskApi`), avoid
  uncaught startup errors, and make no unauthorized network requests. This is
  what `bridgebench ui evaluate` reports, and it needs nothing beyond a
  public clone.
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

`bridgebench ui run` (generate an artifact from a live model and evaluate
it) is not implemented on `main` yet — the season branch's runner was built
against a multi-provider abstraction that no longer exists here (`main`
calls models exclusively through OpenRouter; see
[`src/openrouter.ts`](../src/openrouter.ts)). Porting it means adapting that
runner to `main`'s provider, not just copying the file.

## Task spec

Public task YAML lives at `tasks/current/ui/<id>.yaml` — season-prefixed id,
title, category, viewport, pinned library versions, the public control
contract, screenshot capture points, and the creative prompt. Public files
must never contain a `probes:` key (the loader rejects them); hidden probes
are authored separately as `bridgebench-private/tasks/current/ui/<id>.probes.yaml`.
The full authoring contract (including the probe DSL) is documented in
[`season-engine-alpha`'s `docs/task-authoring.md`](https://github.com/bridge-mind/bridgebench/blob/season-engine-alpha/docs/task-authoring.md).
