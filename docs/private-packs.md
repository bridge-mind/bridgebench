# Private packs — the hidden-reference overlay

Task prompts are public; the expected resolutions, trap inventories, disqualifying-error lists, and rubrics that judges use are not. If they were committed here, they would end up in training data and the benchmark's integrity claim would die. This document covers how the split works mechanically and the policy that keeps it honest.

## Layout

The overlay is a separate, private checkout that mirrors this repo's `tasks/` layout:

```text
<private-checkout>/
└── tasks/
    ├── reasoning/private/<task-id>.yaml       # one per public task, same filename
    └── hallucination/private/<task-id>.yaml
```

Point the engine at it with:

```bash
export BRIDGEBENCH_PRIVATE_DIR=/path/to/private-checkout
```

Resolution order in `src/tasks.ts`: an explicit `privateRoot` constructor argument → the `BRIDGEBENCH_PRIVATE_DIR` overlay → a repo-local `tasks/<category>/private/` directory (maintainer setups only; the public repo never contains one).

## What works without the overlay

| Works from public halves alone | Needs the overlay |
|---|---|
| `npm run tasks -- validate` (public schema + pack balance) | `npm run arena -- run` (judges need the hidden reference) |
| `npm run report` (rebuild snapshots/leaderboards from a journal) | Starting a run from the dashboard |
| `npm run triage`, `arena generation <id>` | Authoring/validating private halves |
| `npm run arena -- publish` (journal sync; admin key required) | `npm run tasks -- publish` (the API stores both halves) |
| The dashboard's Leaderboard and Matches views | |
| `npm test` (offline suites synthesize a stand-in reference) | |

When a judged run is attempted without the overlay, the loader fails closed with a pointer to this document.

## Contamination guard

Two mechanisms keep hidden references out of the public repo:

- `.gitignore` ignores `tasks/*/private/`, so a casually dropped-in overlay can't be staged by `git add -A`.
- CI fails if any tracked path matches `tasks/*/private/` or if hidden-reference fields (`expectedResolution:`, `disqualifyingErrors:`, `rubric:`) appear in any tracked file under `tasks/` (`.github/workflows/ci.yaml`).

When both halves load, `tasks validate` also verifies pairing: matching `id`/`version` and that every `requiredEvidence` entry names a real public artifact.

## Publish-at-retirement

Hidden references are withheld only while their pack is live:

1. **While live** — private halves exist only in the overlay repo. Every journal line records `privateHash`, the SHA-256 of the exact private YAML the judges received.
2. **At retirement** — when a pack rotates out, its private halves are published in full alongside the pack's final journal.
3. **Verification** — anyone can hash the published private halves and compare against the `privateHash` on every journaled match, proving the published references are byte-identical to what decided the matches. Combined with [replay-elo.md](replay-elo.md), a retired season is auditable end to end.

If a published score doesn't reproduce, open an issue.
