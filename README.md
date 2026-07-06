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

> **Status: ground-up rewrite, built in the open.** This repo is the new home of BridgeBench. The engine, task format, and Season 1 are under construction — nothing here is stable yet. Leaderboards live at [bridgebench.ai](https://bridgebench.ai).

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

The Season 1 lineup, carried forward from the suites the previous engine proved out. Each suite maps to a moment in a real vibe coding session:

| Suite | The moment it measures |
|---|---|
| **Speed** | You're in flow. Time-to-first-token and throughput decide whether the model keeps up or breaks it. |
| **Cost** | What a day of shipping actually costs, per model, from published rates. |
| **Debugging** | "Here's the bug. Fix it." Diagnosis and patch, graded separately. |
| **Refactoring** | Improve the structure without changing the behavior — and prove the refactor actually happened. |
| **Algorithms** | Core correctness under hidden adversarial tests and complexity budgets. |
| **UI** | Ship an interface from a one-paragraph prompt, scored in a real browser. |
| **Security** | Does generated code hold up against hostile input? |
| **Hallucination** | Does the model invent APIs and behaviors that don't exist? |
| **Reasoning** | Multi-artifact problems: specs, logs, and tables that have to be reconciled, not pattern-matched. |
| **Pushback** | The premise is nonsense. Does the model say so, or play along? |

Suites are added and refined per season as vibe coding itself evolves — agentic and repo-scale tasks are on the roadmap.

## Methodology

The principles the engine is being rebuilt on:

- **Deterministic first.** Executable tests, real browsers, and structural assertions before LLM judges. Where a judge is unavoidable (e.g. pushback quality), the judge model and rubric are disclosed.
- **Public/private task split.** Visible tests show the contract; hidden correctness and adversarial tests decide the score. Passing the happy path is not passing.
- **Every run is journaled.** Append-only run logs, derived snapshots, full resume. A leaderboard number traces back to the raw runs that produced it.
- **One provider abstraction.** Every provider implements a single streaming interface, so adding a model never touches the measurement logic.
- **Season-stamped provenance.** Model ID, season, methodology version, and timestamp on every result.

Full methodology docs land in [`docs/`](docs/) as the engine takes shape.

## Repository layout

The planned shape of the repo (scaffolding in progress):

```
bridgebench/
├── suites/            # One module per suite: runner, executor, evaluator, README
├── tasks/
│   ├── current/       # Active season — public prompts only
│   └── archive/       # Retired seasons, published in full (hidden tests included)
├── providers/         # Direct provider adapters + pricing
├── results/           # Journals and snapshots for the active season
├── docs/              # Methodology, scoring, season rules
└── assets/            # BridgeMind brand assets
```

Each suite ships with its own README covering task format, scoring dimensions, and weights.

## Quick start

Not yet — the engine is being rebuilt from scratch. Watch this repo; Season 1 ships with a runnable CLI, task packs, and the docs to reproduce every number on [bridgebench.ai](https://bridgebench.ai).

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
