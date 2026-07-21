# Glossary

## Arena

One independent benchmark category with its own task pack, journal, Elo ladder, and leaderboard. Ratings never cross arena boundaries.

## Competitor

A model answering the public task context. Competitors receive no hidden reference and do not know their opponent.

## Judge

A model comparing two anonymized competitor responses against the hidden reference. Judges are fixed, independent, and ineligible as competitors.

## Public task

The prompt and artifacts visible to competitors and committed under `tasks/<category>/public/`.

## Hidden reference

The expected resolution, required evidence, disqualifying errors, and rubric used by judges. Active references live outside the public repository.

## Private overlay

The separate checkout containing active hidden references. `BRIDGEBENCH_PRIVATE_DIR` points the engine to it.

## Run manifest

The canonical inputs that define one deterministic schedule: methodology, engine version, category, seed, match count, model roster and policy, task hashes, and prompt-policy hashes.

## Journal

The append-only local execution record. Each JSONL line contains one completed match and references its run manifest.

## Snapshot

A verified report derived from a journal replay. Snapshots are replaceable; journals are not.

## Point

One win awarded for a judged majority (or measured speed win). No-contests — including matches voided by a failed response — award no point. Historical journals may contain `forfeit` wins from before 2026-07-14, when a failed response awarded the survivor the point.

## Elo

The per-arena rating derived in journal order. Ratings start at 1000 and use K=32.

## Published replica

The bridgebench.ai API copy of verified engine output. Publishing does not replace the local journal as the execution authority.

## UI Bench

The creative-rendering benchmark for self-contained Three.js HTML artifacts. Live model streams are statically validated and published for community voting; optional browser diagnostics run only through `ui evaluate`. Results never mix with arena Elo. See [UI Bench](ui-bench.md).

## Qualification

UI Bench's objective pass/fail gate for live generation: did the artifact satisfy the static self-contained HTML, pinned-import, and harness-global contract. Optional runtime diagnostics are independent of qualification.
