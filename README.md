<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/bridgemind-wordmark-white.png">
    <img src="assets/bridgemind-wordmark-dark.png" alt="BridgeMind" width="280">
  </picture>
</p>

<h1 align="center">BridgeBench</h1>

<p align="center">
  <strong>The world's #1 vibe coding benchmark.</strong><br/>
  Real workflows, measured direct from every provider's API — and rebuilt every 90 days so no model trains on it.
</p>

<p align="center">
  <a href="https://bridgebench.ai">bridgebench.ai</a> &nbsp;&bull;&nbsp;
  <a href="#benchmark-suites">Suites</a> &nbsp;&bull;&nbsp;
  <a href="#seasons--the-90-day-rotation">Seasons</a> &nbsp;&bull;&nbsp;
  <a href="#methodology">Methodology</a> &nbsp;&bull;&nbsp;
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-8A63D2.svg">
  <img alt="Season" src="https://img.shields.io/badge/season_1-in_development-orange.svg">
</p>

---

> **Status: Season 1 engine is here.** The first suite — **UI Bench**, 10 creative Three.js tasks scored in a real browser — is runnable today. The first official model roster run and the bridgebench.ai v3 leaderboard are next. Leaderboards live at [bridgebench.ai](https://bridgebench.ai).

## What is BridgeBench?

BridgeBench measures how models perform as vibe coding partners — not how they score on puzzle sets. Every task starts from something a builder actually does: describe a feature in plain language, hand over a bug, ship an interface, ask about an API, push back when the premise is wrong.

It's built by [BridgeMind](https://bridgemind.ai), the agentic organization behind BridgeSpace, BridgeVoice, and BridgeAgent. We benchmark models because we ship with them daily — the leaderboard is the same data we use to pick our own teammates.

Three rules separate BridgeBench from every other leaderboard:

1. **Real workflows.** Tasks mirror vibe coding as builders practice it: intent in natural language, code out, verified end to end. If a task wouldn't come up while shipping real software, it doesn't belong in the benchmark.
2. **Direct to provider.** Every measurement hits the provider's own API — OpenAI, Anthropic, Google, xAI, and the rest. No aggregators in the measurement path. You measure the model, not the middleman.
3. **A 90-day shelf life.** Every season, tasks retire and fresh ones take their place. A benchmark that never changes ends up in someone's training set; ours expires before it can.

## Seasons — the 90-day rotation

Static benchmarks decay. Tasks leak into training data, scores inflate, and the leaderboard stops measuring the model and starts measuring memorization. BridgeBench is built around that reality instead of pretending it away:

- **Every ~90 days a new season ships.** A season is a versioned generation of tasks across all suites (e.g. `2026-S1`, `2026-S2`).
- **Hidden tests stay hidden — until retirement.** During a season, public task prompts live in this repo; the hidden correctness and adversarial tests that decide scores do not. When the season ends, the full task set — hidden tests included — is published to the archive, so anyone can audit exactly what was measured.
- **Methodology persists, tasks rotate.** Scoring dimensions, weights, and the measurement pipeline stay stable across seasons, so a model's trajectory is comparable even as the tasks underneath it change.
- **Scores are stamped with their season.** No mixing results across task generations. Ever.

## Benchmark suites

### UI Bench — live in this repo

Season 1 opens with the suite that made BridgeBench famous — the lava lamp test — rebuilt for real 3D. **10 creative tasks**, all Three.js (pinned `0.182.0`, vendored in this repo), all scored in a real browser:

Lava Lamp Redux · Aurora Over a Frozen Lake · Galaxy Forge · Synthwave Horizon · Deep-Sea Jellyfish Ballet · Clockwork Orrery · Voxel Weather Diorama · Kinetic Typography · Rubik's Playground · Bioluminescent Terrarium

Every artifact is one self-contained HTML file whose only external reference is the pinned, same-origin three.js import map.

**Graded by builders, not bots.** No AI and no scoring formula judges the output. Models are ranked by **blind A/B community voting** on [bridgebench.ai](https://bridgebench.ai): two artifacts for the same task, models hidden, builders pick the better one, Elo does the math. The vote log is public and the ratings replay from it.

The harness's only judgment is objective **arena qualification** — an artifact enters the vote pool if it:

| Gate | Check |
|---|---|
| Self-contained | Static validation: pinned vendor import map is the only external reference |
| Runs | Loads without an uncaught startup error |
| Follows the contract | Both BridgeBench harness globals appear |
| Shows something | First frame isn't blank |
| Stays offline | Zero non-vendor network attempts (every request is intercepted) |

Everything else the harness measures — WebGL context, FPS, animation, control coverage, `reset(seed)` determinism replay, hidden interaction probes — is recorded as **informational badges** beside the artifact, so voters can see whether the controls actually work. Badges never touch the ranking.

Docs: [architecture](docs/architecture.md) · [running](docs/running.md) · [task authoring](docs/task-authoring.md) · [season policy](docs/season-policy.md)

### On the roadmap

The suites the previous engine proved out, returning season by season: **Speed** (TTFT/throughput direct from each API), **Cost**, **Debugging**, **Refactoring**, **Algorithms**, **Security**, **Hallucination**, **Reasoning**, and **Pushback** (the premise is nonsense — does the model say so?). Agentic and repo-scale tasks are on the roadmap too.

## Methodology

The principles the engine is being rebuilt on:

- **Deterministic first.** Executable tests, real browsers, and structural assertions before LLM judges. Where a judge is unavoidable (e.g. pushback quality), the judge model and rubric are disclosed.
- **Public/private task split.** Visible tests show the contract; hidden correctness and adversarial tests decide the score. Passing the happy path is not passing.
- **Every run is journaled.** Append-only run logs, derived snapshots, full resume. A leaderboard number traces back to the raw runs that produced it.
- **One provider abstraction.** Every provider implements a single streaming interface, so adding a model never touches the measurement logic.
- **Season-stamped provenance.** Model ID, season, methodology version, and timestamp on every result.

Full methodology docs land in [`docs/`](docs/) as the engine takes shape.

## Repository layout

```
bridgebench/
├── src/
│   ├── cli.ts             # bridgebench ui run / evaluate / tasks · providers
│   ├── config.ts          # season pins: dates, three.js version, viewport
│   ├── providers/         # direct provider adapters (one stream() each) + pricing
│   └── suites/ui/         # runner → extractor → normalizer → validator →
│                          #   evaluator (Playwright, 2 phases) → score → snapshot
├── tasks/
│   ├── current/ui/        # active season — public prompts + declared controls
│   └── retired/           # past seasons, published in full (hidden tests included)
├── vendor/three@0.182.0/  # season-pinned three.js + addons (committed, hermetic)
├── fixtures/              # golden artifacts (correct / broken / cheating)
├── snapshots/             # committed season snapshots
├── docker/Dockerfile.eval # pinned Chromium for official, reproducible runs
├── scripts/               # vendor-three, sync-to-ui
└── docs/                  # architecture, running, task authoring, season policy
```

## Quick start

```bash
git clone https://github.com/bridge-mind/bridgebench.git
cd bridgebench && npm install
cp .env.example .env       # add your provider keys

# Grade the included golden artifact — no API keys needed
npm run ui -- evaluate fixtures/golden-correct.html -t s1-lava-lamp-redux

# Run a model across all 10 Season 1 tasks
npm run ui -- run -m openai/gpt-5.4

# List tasks and configured providers
npm run ui -- tasks
npm run providers
```

Interaction scoring uses hidden probes (private during the season, published at rotation — see [season policy](docs/season-policy.md)). Without them, runs are still fully functional and marked `partial`.

## Contributing

BridgeBench is open source and open to builders:

- **Propose tasks** for a future season. Task submissions go through a private channel so hidden tests stay uncontaminated — see `CONTRIBUTING.md` (coming with Season 1).
- **Add a provider.** If it speaks an OpenAI-compatible API, it's a registry entry and a pricing row.
- **Audit the archive.** Retired seasons are published in full. If a score doesn't reproduce, open an issue.

## License

[MIT](LICENSE)

---

<p align="center">
  <img src="assets/bridgemind-symbol.png" alt="BridgeMind" width="40"><br/><br/>
  Built by <a href="https://bridgemind.ai">BridgeMind</a> — the agentic organization.<br/>
  <sub>Ship software at the speed of thought. This is vibe coding.</sub>
</p>
