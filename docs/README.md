# BridgeBench documentation

Start with the contract, then follow the workflow you need.

## Protocol

- [Methodology](methodology.md) — scheduling, blind judging, outcomes, and Elo.
- [Replay Elo](replay-elo.md) — verify a journal and reproduce its ladder.
- [Private packs](private-packs.md) — hidden-reference data flow and contamination controls.

## Contributing

- [Task authoring](task-authoring.md) — public schema, private schema, clusters, and validation.
- [Glossary](glossary.md) — the terms used by the engine, CLI, and published reports.
- [Repository contribution guide](../CONTRIBUTING.md) — local checks and pull-request expectations.

## Canonical sources

- Model roster and request policy: [`src/models.ts`](../src/models.ts)
- Category and methodology constants: [`src/types.ts`](../src/types.ts)
- Task-pack invariants: [`src/tasks.ts`](../src/tasks.ts)
- Journal verification: [`src/verification.ts`](../src/verification.ts)
- CLI workflows: `npm run arena -- --help` and `npm run tasks -- --help`

When prose and executable validation disagree, treat the code as the current behavior and open an issue to repair the documentation.
