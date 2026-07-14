# BridgeBench documentation

Choose the path that matches what you are trying to verify or change.

## Review a benchmark result

1. [Reviewing BridgeBench](reviewing-bridgebench.md) — the guided path from a
   public task through votes, journal evidence, and replayed Elo.
2. [Methodology](methodology.md) — the canonical scheduling, execution,
   anonymization, voting, failure, and scoring contract.
3. [Replay the Elo](replay-elo.md) — reproduce a ladder and validate every
   journal transition.
4. [Private packs](private-packs.md) — understand hidden references,
   contamination controls, retirement, and the external trust boundary.

Use the [glossary](glossary.md) whenever a contract term is unfamiliar.

## UI Bench

- [UI Bench](ui-bench.md) — the browser-scored Three.js creative-rendering
  benchmark, kept separate from arena Elo: qualification vs. probes, how to
  run and evaluate the restored lava lamp task, and what's still on the
  `season-engine-alpha` branch.

## Contribute

- [Task authoring](task-authoring.md) — public/private schemas, arena clusters,
  balance invariants, and proposal workflow.
- [Repository contribution guide](../CONTRIBUTING.md) — local checks,
  pull-request expectations, task proposals, and audit reports.
- [Security policy](../SECURITY.md) — report vulnerabilities privately.

## Operate and release

- [Operator guide](operator-guide.md) — paid runs, results, dashboard, triage,
  resume, and publishing.
- [Private packs](private-packs.md) — required reading before handling active
  hidden references.
- [Release guide](../RELEASING.md) — npm trusted publishing and tag workflow.

## Canonical executable sources

- Model roster and request policy: [`src/models.ts`](../src/models.ts)
- Category and methodology constants:
  [`src/contracts/categories.ts`](../src/contracts/categories.ts)
- Task-pack invariants: [`src/tasks.ts`](../src/tasks.ts)
- Journal verification: [`src/verification.ts`](../src/verification.ts)
- Elo implementation: [`src/elo.ts`](../src/elo.ts)
- CLI workflows: `npm run arena -- --help` and `npm run tasks -- --help`

When prose and executable validation disagree, treat the executable contract
as current behavior and open an issue to repair the documentation.
