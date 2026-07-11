# Private packs — the hidden-reference overlay

Task prompts are public. Active expected resolutions, trap inventories, disqualifying-error lists, and rubrics are withheld from the public repository to reduce contamination risk. This document defines where those hidden references travel, who stores them, and how they are retired.

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

| Works from public halves alone                                   | Needs the overlay                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| `npm run tasks -- validate` (public schema + pack balance)       | `npm run arena -- run` (judges need the hidden reference) |
| `npm run report` (rebuild snapshots/leaderboards from a journal) | Starting a run from the dashboard                         |
| `npm run triage`, `arena generation <id>`                        | Authoring/validating private halves                       |
| `npm run arena -- publish` (journal sync; admin key required)    | `npm run tasks -- publish` (the API stores both halves)   |
| The dashboard's Leaderboard and Matches views                    |                                                           |
| `npm test` (offline suites synthesize a stand-in reference)      |                                                           |

When a judged run is attempted without the overlay, the loader fails closed with a pointer to this document.

## Data flow and trust boundaries

An active hidden reference is not confined to the overlay during a run:

1. `TaskLoader` reads it into the local operator process.
2. `JudgePanel` includes it in requests to the three configured model judges.
3. The local journal stores its SHA-256 hash, not its contents.
4. `tasks publish` may send it to the configured BridgeBench API, where it is stored outside public read endpoints.

The operator machine, configured model providers, transport provider, and private API store are therefore inside the active-pack trust boundary. Their retention and access policies matter. Withholding references from Git history and public issues reduces exposure; it cannot prove that a third party never retains or trains on transmitted content.

If an active reference leaks:

1. stop paid runs for that pack;
2. record the affected task IDs and first-known exposure time;
3. rotate the compromised tasks and bump their versions;
4. start a new run manifest and journal;
5. disclose the incident with the retired references when doing so no longer exposes live tasks.

## Contamination guard

Three mechanisms keep hidden references out of the public repo:

- `.gitignore` ignores `tasks/*/private/`, so a casually dropped-in overlay can't be staged by `git add -A`.
- CI fails if any tracked path matches `tasks/*/private/`.
- CI parses tracked task YAML and rejects every private-only top-level field, including `expectedResolution`, `requiredEvidence`, `disqualifyingErrors`, and `rubric`.

When both halves load, `tasks validate` also verifies pairing: matching `id`/`version` and that every `requiredEvidence` entry names a real public artifact.

## Publish-at-retirement

Hidden references are withheld only while their pack is live:

1. **While live** — private halves are absent from the public repo. They remain in the overlay and the private systems named in the trust boundary above. Every journal line records `privateHash`, the SHA-256 of the exact private YAML the judges received.
2. **At retirement** — when a pack rotates out, its private halves are published in full alongside the pack's final journal.
3. **Verification** — anyone can hash the published private halves and compare them with each journaled `privateHash`. `arena verify` checks the journal's match and Elo invariants; the hash comparison checks task identity.

If a published score doesn't reproduce, open an issue.
