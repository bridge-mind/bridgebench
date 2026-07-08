# Running UI Bench

## Setup

```bash
npm install
npm run vendor:three        # only needed if vendor/ is missing or the pin changed
cp .env.example .env        # add your provider API keys
```

Provider keys are read from `.env.local` / `.env` at the repo root (see
`.env.example` for names) or passed inline with `--api-key provider=key`.

Chromium: local runs use system Google Chrome; official runs use the pinned
image in `docker/Dockerfile.eval`. Override with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

Hidden probes (maintainers only):

```bash
export BRIDGEBENCH_PRIVATE_DIR=/path/to/bridgebench-private
```

Without it, everything still runs — interaction scores are computed from
declared-control presence and flagged `partial`.

## Commands

```bash
# Full season run for one model
npm run ui -- run -m openai/gpt-5.4

# Several models, custom display names
npm run ui -- run -m openai/gpt-5.4,anthropic/claude-opus-4-6 -n "GPT-5.4,Claude Opus 4.6"

# One task
npm run ui -- run -m openai/gpt-5.4 -t s1-lava-lamp-redux

# Resume an interrupted run (skips successful pairs in the journal)
npm run ui -- run -m openai/gpt-5.4 --resume

# Generate + validate only (no browser)
npm run ui -- run -m openai/gpt-5.4 --dry

# Echo debug-level log events to the console while running
npm run ui -- run -m openai/gpt-5.4 --debug

# Grade an existing artifact file (no API keys needed)
npm run ui -- evaluate fixtures/golden-correct.html -t s1-lava-lamp-redux

# List tasks / providers
npm run ui -- tasks
npm run providers
```

## Outputs

```
results/ui/journal.jsonl                    append-only source of truth
results/ui/snapshot.json                    derived roster snapshot (v3)
results/ui/artifacts/<task>/<slug>/<run>/   artifact.html, normalized.html,
                                            raw.txt, metadata.json, *.png
results/ui/logs/<run-id>/run.jsonl          full-fidelity debug log (every stage)
results/ui/logs/<run-id>/run.log            human-readable mirror
snapshots/season-1/ui-bench-snapshot.json   committed season snapshot
```

## Debug logging

Every `ui run` / `ui evaluate` writes a flight-recorder log under
`results/ui/logs/<run-id>/`. `run.jsonl` records one structured event per
stage — provider request (tuning, overrides, full prompt), stream progress
and retries, HTTP finish reason and usage, the full raw model response,
extraction strategy, normalization, validation errors, the complete browser
evaluation (console sample, page errors, blocked network, probes,
determinism), and the final qualification with reasons. `run.log` is the
same stream with long strings truncated for scanning.

Knobs: `--debug` echoes debug events to the console;
`BRIDGEBENCH_LOG_LEVEL` / `BRIDGEBENCH_LOG_ECHO` (debug|info|warn|error)
tune the file and console thresholds.

Debugging a disqualified task: `grep task.result run.jsonl | jq .reasons`,
then walk backwards through that task's `validation.done`,
`evaluation.done`, and `provider.http.complete` events — a `finishReason`
of `length` means the completion budget truncated the artifact (fix the
model's `tuning` in `src/providers/models.ts`).

## Publishing to bridgebench.ai

```bash
npm run sync:ui       # snapshot + lite leaderboard + artifacts + vendor → ../bridgebench-ui
# …deploy bridgebench-ui, then register artifacts with the voting API:
UI_BENCH_ADMIN_KEY=… npm run publish:artifacts
```

Keep the sync on a bridgebench-ui feature branch until the site's v3 data
layer lands — main still renders the legacy snapshot shape. Voting flow:
qualified artifacts enter blind A/B matchups at bridgebench.ai/ui-bench/vote;
builders' votes drive per-artifact Elo; the model grade is its average Elo.

## Official (reproducible) runs

```bash
docker build -f docker/Dockerfile.eval -t bridgebench-eval .
docker run --rm -v "$PWD:/bench" -w /bench \
  -e BRIDGEBENCH_PRIVATE_DIR=/bench-private \
  -v /path/to/bridgebench-private:/bench-private:ro \
  --env-file .env \
  bridgebench-eval npm run ui -- run -m openai/gpt-5.4
```

Same pinned Chromium + fonts everywhere ⇒ pixel-identical screenshots ⇒
reproducible scores.
