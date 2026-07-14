# Operating BridgeBench

This guide covers paid arena runs, local result custody, the dashboard,
triage, and publishing. Reviewers do not need any of this setup; use
[Reviewing BridgeBench](reviewing-bridgebench.md) for the credential-free path.

## Requirements and private inputs

Use Node.js 20.19 or newer and npm 10 or newer.

A judged run requires:

1. `OPENROUTER_API_KEY` in the operator process environment;
2. `BRIDGEBENCH_PRIVATE_DIR` pointing to the separate private-pack checkout.

Keep both values out of source, shell output, screenshots, issue reports, and
logs. Set an account-level OpenRouter spending limit before a paid run.
BridgeBench validates the selected model IDs, canonical slugs, and judge
structured-output support before spending.

The private overlay mirrors the public task layout:

```text
<private-checkout>/
└── tasks/
    ├── reasoning/private/<task-id>.yaml
    └── hallucination/private/<task-id>.yaml
```

See [Private packs](private-packs.md) for resolution order, data flow,
contamination controls, rotation, and retirement.

## Model transport and roster

Every competitor and judge request uses OpenRouter with exact, pinned slugs;
`latest` aliases are prohibited. The benchmark therefore measures model
behavior through one aggregator's routing rather than direct provider APIs.

The canonical roster and request policies live in
[`src/models.ts`](../src/models.ts). Judges are never eligible competitors.
OpenRouter generation records can be retrieved later with
`npm run arena -- generation <id>` for independent cost, token, and routing
checks.

## Run an arena

Default category runs:

```bash
npm run arena -- run --category reasoning
npm run arena -- run --category hallucination
```

Set an explicit schedule and stop boundary:

```bash
npm run arena -- run \
  --category hallucination \
  --matches 24 \
  --seed july-calibration \
  --max-cost-usd 40
```

Use repeated `--competitor` flags to select an explicit roster of at least two
unique, enabled competitors:

```bash
npm run arena -- run \
  --category reasoning \
  --competitor openai/gpt-5.6-sol \
  --competitor anthropic/claude-fable-5
```

Without `--competitor`, the run uses every enabled competitor. Press Ctrl-C
once to request cancellation: active calls abort, completed matches remain
journaled, and the exact schedule can resume.

## Run identity and resume

Category, seed, match count, sorted roster, task hashes, request policies,
prompt-policy hashes, methodology, and engine version define the run manifest.
The run ID is derived from that canonical manifest.

Resume only the matching schedule:

```bash
npm run arena -- run \
  --category hallucination \
  --matches 24 \
  --seed july-calibration \
  --max-cost-usd 40 \
  --resume
```

Journaled match IDs are skipped exactly. Repeating a completed schedule without
`--resume` is rejected.

## Local result custody

Results are ignored by Git and isolated by arena:

```text
results/<category>/journal.jsonl       append-only execution record
results/<category>/runs/<run-id>.json versioned run manifest
results/<category>/snapshot.json       verified derived view
results/<category>/leaderboard.md      verified derived view
results/<category>/logs/               structured redacted logs
```

The journal is authoritative. Verify it before rebuilding or publishing:

```bash
npm run arena -- verify --category reasoning
npm run report
```

Reports, resume state, and publishing all use the same fail-closed verifier.

## Local dashboard

```bash
npm run dashboard
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The dashboard provides:

- **Arena** — run configuration and live competitor/judge progress;
- **Leaderboard** — the verified per-category ladder;
- **Matches** — public task context, full responses, votes, and rationales.

The control plane binds only to `127.0.0.1`. The API key remains in the server
process and is never serialized to the browser. Mutations require a same-origin
JSON request, only one run can be active, and model output is escaped text.

## Triage and continuous improvement

Every run writes a structured, key-redacted JSONL log. The triage command
checks for failed requests, suspiciously fast responses, truncation, judge
abstentions, and other anomalies. A health stop halts a run that is mostly
producing failures.

```bash
npm run arena -- run --debug
npm run triage
npm run arena -- generation gen-...
```

Use the loop: run → read the health report → inspect the run log and provider
record → fix the task, prompt, or policy → use a fresh seed → compare reports.
Do not overwrite or hand-edit a journal to repair an outcome.

## Publish

An explicit API target and category are required. Configure
`BRIDGEBENCH_API_URL` and `BRIDGEBENCH_ADMIN_KEY` privately before invoking:

```bash
npm run tasks -- publish --category hallucination
npm run arena -- publish --category reasoning
```

`tasks publish` may send both task halves to the private API store.
`arena publish` syncs verified journal evidence. Never place active hidden
references or admin credentials in command output, commits, or issue reports.

Package releases follow [RELEASING.md](../RELEASING.md). A release must pass
the public-clone quality gate and contamination check before npm publishing.

## Operating guardrails

- Use pinned model slugs and a fixed, recorded roster.
- Set a budget cap and account-level provider limit before paid work.
- Treat competitor responses as adversarial input; never execute their code or
  commands.
- Stop and rotate a pack if an active hidden reference leaks.
- Keep categories in separate journals and Elo ladders.
- Preserve append order; never edit a journal in place.
- Publish retired private halves so their recorded hashes become auditable.
