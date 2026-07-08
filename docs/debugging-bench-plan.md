# Debugging Bench — Season Suite Plan

Status: **Phase 0 (contract lock) in progress**
Owner: BridgeBench / Benchmark Infra
Supersedes: `bridgebench-legacy/v2/DEBUGGING_BENCH_V2_IMPLEMENTATION_PLAN.md`

## Objective

A deterministic, evidence-driven debugging suite for the season engine that
measures whether a model can:

1. interpret realistic evidence (user report, stack trace, failing test output),
2. localize the **root cause** across a multi-file module — not just the symptom site,
3. repair the defect,
4. preserve all surrounding behavior (hidden regression suites),
5. keep the patch disciplined instead of rewriting the module.

## The hardness mandate

This suite exists to **rank frontier models correctly**. That is the design
constraint everything else serves. Single-function "spot the off-by-one"
tasks (the legacy v1/v2 corpus) are solved at ~100% by every current
frontier model — they measure nothing at the top of the leaderboard.

Difficulty comes from six engineered sources, not from obscurity:

| Source | Mechanism |
|---|---|
| **Distance** | Bug manifests far from its root cause — the failing test exercises file A, the defect lives in file C, and patching the symptom site passes the visible repro but fails hidden coverage. |
| **Misleading evidence** | Stack traces point at the symptom frame; the user report describes a plausible-but-wrong theory; a "recent change" note highlights an innocent diff. Models that pattern-match evidence instead of reasoning about it get punished by hidden tests. |
| **Shallow-fix traps** | Visible repro tests are deliberately narrow. `hiddenBugCoverage` tests exercise the same defect through every other path; a special-cased patch that hardcodes around the visible example scores near zero there. |
| **Interacting defects (expert tier)** | Two coupled bugs where fixing one exposes or requires the other. Partial fixes fail hidden coverage. |
| **Regression pressure** | Hidden regression suites assert adjacent behavior including *performance-shaped* contracts (e.g. memoization still caches — call-count assertions), so "rewrite it naively" patches fail even when functionally correct. |
| **Patch discipline** | Structural assertions (export shape, entry points, AST edit ratio, no new deps) cap evasive full rewrites. |

Multi-file is **in scope from day one** (5–15 files, 300–1500 LOC per task,
pure TypeScript, zero dependencies, in-memory only). That reverses the
legacy plan's single-file scoping — single-file cannot produce ceiling for
2026 frontier models.

## Ranking-validity methodology (how we know the ordering is right)

Hardness alone is not the goal — **discrimination** is. The corpus is
calibrated, not just authored:

1. **Target band.** Frontier roster mean score lands in **35–65%**. A task
   where every calibration model passes fully is retired to the floor set or
   reworked; a task where every model scores 0 is diagnosed (ambiguity vs.
   genuine ceiling) and usually reworked — a task nobody solves also ranks
   nobody.
2. **Calibration sweep.** During corpus build, every candidate task runs
   against 4–6 frontier models (OpenAI, Anthropic, Google, xAI rosters)
   **before** acceptance. Per-task acceptance requires:
   - solve-rate spread ≥ 2 distinct outcome bands across the roster,
   - positive item-total discrimination (models that do well overall do
     better on this task — point-biserial vs. rest-of-corpus score > 0.2),
   - no ambiguity failures (two defensible fixes scoring differently → fix
     the hidden tests or kill the task).
3. **Repeats + confidence intervals.** Official runs are **n ≥ 5 repeats**
   per model×task. Leaderboard shows mean with bootstrap 95% CI; two models
   whose CIs overlap are shown as statistically tied rather than
   artificially ordered.
4. **Rank stability check.** Before a season's leaderboard is published,
   bootstrap-resample the task set; the top-5 ordering must be stable in
   ≥ 90% of resamples, otherwise the corpus is underpowered and gets more
   tasks or more repeats.
5. **Floor set.** 4 medium tasks exist purely to separate the bottom of the
   roster (small/fast models); they carry normal weight but are expected to
   saturate at the top. The other ~20+ tasks do the ranking work up top.
6. **Determinism.** No LLM judge in the score path. Root-cause accuracy is
   scored by deterministic matching against a private answer key (accepted
   phrases, affected symbols, category). Where paraphrase matching proves
   too brittle, a disclosed judge model + rubric may score *only* the
   `rootCauseAccuracy` dimension (15% weight) — never correctness.

## Benchmark shape (Season 1 target)

- **28 tasks**: 4 medium (floor) · 16 hard · 8 expert.
- **Clusters** (evidence surface, 4–5 tasks each):
  `test-failure` · `runtime-exception` · `incorrect-output` ·
  `async-timing` · `state-mutation` · `regression-after-refactor`
- Internal bug tags for analysis (off-by-one, stale cache, missing await,
  accidental mutation, race, boundary, contract mismatch, time-window,
  unicode/locale, resource lifecycle…). Tags are private until retirement —
  they leak the answer.
- Task IDs: `s1-debug-<slug>` (season-stamped like UI Bench).

## Task format

Follows the season engine's public/hidden split:

```
bridgebench/tasks/current/debugging/s1-debug-<slug>.yaml        # public
bridgebench-private/tasks/current/debugging/<id>.hidden.yaml    # private overlay
```

**Public** (what the model sees + what anyone can audit): id, season,
cluster, difficulty, title, prompt, `files` (the buggy multi-file module),
`entryPoint` (module + exported symbol(s) under test), `visibleEvidence`
(userReport / stackTrace / failingTestOutput / notes), `publicReproTests`,
`constraints` (preserve exports, no new deps, files the patch may touch),
`responseContract`.

**Hidden overlay** (private during the season, published in full at
rotation): `hiddenBugTests`, `hiddenRegressionTests` (including
call-count/behavioral-contract assertions), `diagnosisAnswerKey`
(acceptable root-cause phrasings, bug category, affected symbols),
`patchRules` + structural assertions, optional per-task scoring overrides.

**Submission contract** — machine-checkable, two parts:

````text
```json debug-diagnosis
{ "rootCause": "...", "bugCategory": "...", "affectedFiles": ["src/x.ts"],
  "affectedSymbols": ["fn"], "whyItFails": "..." }
```

```typescript path=src/x.ts
// full replacement contents of every file the model changes
```
````

Unchanged files are inherited from the task; only changed files are
returned. Diagnosis extraction failure → `rootCauseAccuracy = 0` but the
run continues; code extraction failure → hard fail.

## Scoring model (methodology-stable across seasons)

| Dimension | Weight | Measures |
|---|---|---|
| `visibleReproFix` | 15 | Visible repro tests pass — necessary, not sufficient |
| `hiddenBugCoverage` | 30 | Same defect exercised through every other path — kills shallow fixes |
| `regressionResistance` | 25 | Hidden tests on adjacent behavior + behavioral contracts |
| `rootCauseAccuracy` | 15 | Deterministic diagnosis match vs. answer key |
| `patchDiscipline` | 10 | Structural assertions, edit-ratio, constraint compliance |
| `efficiency` | 5 | Bounded runtime score |

Hard fail (score 0): no extractable code · patched module doesn't load ·
required export/entry point missing. Caps: visible repro still failing →
cap 49; repro fixed but regression resistance below threshold → cap 69.

Ranking: score is deterministic (unlike UI Bench's community Elo — that
suite is subjective by nature; debugging is not). Sort: avg score →
regression pass rate → hidden coverage → diagnosis accuracy.

## Execution model

- **Sandbox:** transpile TS (`typescript.transpileModule`), link the
  multi-file module graph in a restricted Node `vm` context (no `require`
  escape, no network, no fs), memory + wall-clock limits.
- **Virtual clock:** injected deterministic clock/scheduler utility
  (task-provided `clock.ts` style) so `async-timing` tasks are exactly
  reproducible — no real timers, no flakes.
- **Pins:** Node version pinned per season in `docker/Dockerfile.eval`
  (extend the existing image); TypeScript version pinned in the season
  config. Every result carries season id + engine pins, journaled to the
  same append-only JSONL → snapshot flow as UI Bench.
- **Provider layer reused unchanged** (`src/providers/`): one `stream()`
  per provider, model registry supplies identity/pricing/tuning.

## Pipeline (per model × task)

```
runner → diagnosis parser + file-block extractor → module assembler
      → static validator (contract, constraints) → sandbox executor
      → [visible repro | hidden coverage | hidden regression] suites
      → patch analyzer (AST diff vs. original) → score → journal → snapshot
```

## Repository layout (new code)

```
src/suites/debugging/
  types.ts             # public + hidden schemas, results, score breakdown
  task-loader.ts       # public yaml + BRIDGEBENCH_PRIVATE_DIR overlay merge
  prompt-builder.ts    # evidence-first prompt assembly
  extractor.ts         # diagnosis JSON + ```lang path=… file blocks
  assembler.ts         # original files + returned files → candidate module
  validator.ts         # contract & constraint static checks
  executor/            # vm sandbox, module linker, virtual clock, limits
  patch-analyzer.ts    # export shape, entry points, AST edit ratio, deps
  scorer.ts            # weights, caps, hard fails
  runner.ts            # provider loop w/ retry (mirrors ui/runner.ts)
  store.ts             # journal + snapshot (mirrors ui/store.ts)
  aggregator.ts        # leaderboard rows, cluster breakdown, CIs
tasks/current/debugging/            # public tasks
../bridgebench-private/tasks/current/debugging/   # hidden overlays
fixtures/debugging/                 # golden correct / shallow / evasive patches
```

CLI: `bridgebench debugging run|evaluate|tasks` mirroring the `ui`
subcommand (`-m`, `-t`, `--cluster`, `--resume`, `--repeats`).

## Anti-contamination

- Every task is authored fresh for the season — never lifted from public
  repos, blogs, or the legacy corpus verbatim (legacy tasks are almost
  certainly in training data; at most they seed *ideas*).
- Authoring is **private-first**: the full task (correct module, bug
  injection, all tests, answer key) is built in `bridgebench-private`; a
  generator emits the public YAML by stripping hidden fields. The public
  repo never sees an answer key in git history.
- Hidden tests + answer keys + bug tags publish only at season retirement
  (same rule as UI probes).
- 90-day rotation applies: debugging tasks retire with the season.

## Fixtures & self-test (before any model runs)

For each task, three golden patches are committed privately:
1. **correct** — true root-cause fix → must score ≥ 90,
2. **shallow** — passes visible repro only → must be capped ≤ 49 by hidden
   coverage,
3. **evasive** — full rewrite that passes tests → must lose patch-discipline
   points and trip structural assertions.

A task ships only when all three golden patches score in their expected
bands. This is the suite's own unit test for ranking validity.

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0 — Contract lock** | This doc, `types.ts` schemas, submission contract, 1 exemplar task pair (public + hidden) | Schemas reviewed, exemplar loads |
| **1 — Engine** | loader → extractor → assembler → executor → scorer → CLI | Exemplar runs end-to-end against golden fixtures |
| **2 — Analysis layer** | patch analyzer, diagnosis scoring, structural assertions | 3 golden patches score in expected bands on exemplar |
| **3 — Corpus** | 28 tasks (private-first authoring), golden patch triple per task | Cluster/difficulty mix hit; every task passes fixture self-test |
| **4 — Calibration** | 4–6 model sweep, n≥5 repeats; discrimination report | Roster mean in 35–65%; per-task discrimination criteria met; rank-stability bootstrap ≥ 90% |
| **5 — Rollout** | Official roster run, snapshot, bridgebench.ai leaderboard integration | Season-stamped snapshot published; CIs shown |

## Explicitly out of scope (this season)

npm-dependency debugging · native builds · browser/framework runtime bugs ·
networked services & databases · screenshot-driven UI debugging. These are
roadmap items once the pure-TS multi-file suite proves discrimination.
