# Architecture

BridgeBench is a season-based benchmark engine. One suite ships in Season 1:
**UI Bench** — 10 creative Three.js tasks scored in a real browser.

## Pipeline (per model × task)

```
runner → extractor → normalizer → validator → artifact store
                                       │
                                       ▼ (valid only)
                          evaluator (Playwright, two phases)
                                       │
                                       ▼
                         score → JSONL journal → snapshot v3
```

- **runner** (`src/suites/ui/runner.ts`) streams the completion from the
  provider with retry/backoff and a per-model tuning table that keeps
  reasoning traces from truncating or polluting the HTML.
- **extractor** (`extractor.ts`) recovers the HTML document from raw model
  output (fenced, unfenced, embedded, truncated).
- **normalizer** (`normalizer.ts`) rewrites any import map that maps `three`
  to the byte-exact canonical pinned map, injects it when missing, ensures a
  `<title>`. The normalized artifact is what gets evaluated and published.
- **validator** (`validator.ts`) statically enforces the contract: one
  self-contained document; the pinned same-origin vendor files are the ONLY
  permitted external reference; only `three` / `three/addons/…` module
  specifiers; harness globals present.
- **evaluator** (`evaluator/`) — see below.
- **score** (`score.ts`) — five dimensions, weights 25/15/30/15/15, hard-fail
  gates to zero. Community Elo (Phase 2) is a separate axis, never folded in.
- **stores** — append-only JSONL journal (crash-safe, `--resume`), derived
  snapshot rebuilt atomically, season-stamped.

## Provider layer

Every provider implements one `stream()` method yielding uniform
`StreamChunk` objects (`src/providers/`). Adding a provider = a registry
entry + a pricing row; the measurement pipeline never changes.

## Evaluator

Runs on Chromium with **SwiftShader software WebGL**
(`--use-angle=swiftshader --enable-unsafe-swiftshader`) so official runs are
pixel-reproducible across machines. Artifacts load on a synthetic origin
(`http://ui-bench.local`) with `route.fulfill` serving the document and
`/vendor/**` from disk; every other request is aborted and counted — a
single non-vendor network attempt hard-fails the artifact.

**Phase A (real time)**: verify both harness globals
(`BridgeBenchTaskManifest`, `BridgeBenchTaskApi`) appear within 5s; record
requested canvas contexts + unmasked GL renderer via an init-script spy;
sample rAF FPS (~2s, diagnostic floor only — SwiftShader is CPU-slow by
design); detect animation with composited-screenshot pixel diffs (WebGL
visible, unlike a 2D `getImageData` read-back); capture gallery screenshots
at task-specified timestamps; run the hidden interaction probes (see
`task-authoring.md`); smoke `getScore()`/`destroy()`.

**Phase B (virtual time)**: fresh page, `page.clock.install()` fakes
`performance.now`/rAF/timers, then `reset(42) → run 1500 virtual ms →
screenshot` twice. Replays must match within a pixel tolerance (default
1.5% changed pixels) and `getState()` twins must deep-equal.

## Determinism guarantees

- three.js pinned per season, vendored and committed (`vendor/three@<ver>/`).
- Chromium pinned via `docker/Dockerfile.eval` for official runs.
- SwiftShader CPU rasterization: no GPU variance.
- `--js-flags=--random-seed=42` pins `Math.random` as belt-and-braces; the
  contract additionally requires all artifact randomness to flow from
  `reset(seed)`.
- Every result carries `artifactSha256`, season id, engine + three versions.
