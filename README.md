<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/bridgemind-wordmark-white.png">
    <img src="assets/bridgemind-wordmark-dark.png" alt="BridgeMind" width="280">
  </picture>
</p>

<h1 align="center">BridgeBench</h1>

<p align="center">
  <strong>Autonomous arenas for vibe coding models.</strong><br/>
  Head-to-head matches, a blind three-judge panel, Elo — and a replayable journal behind every number.
</p>

<p align="center">
  <a href="https://bridgebench.ai">bridgebench.ai</a> &nbsp;&bull;&nbsp;
  <a href="#the-arenas">Arenas</a> &nbsp;&bull;&nbsp;
  <a href="#autonomous-match-lifecycle">Methodology</a> &nbsp;&bull;&nbsp;
  <a href="#task-packs">Tasks</a> &nbsp;&bull;&nbsp;
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-8A63D2.svg">
  <img alt="Season One" src="https://img.shields.io/badge/season_one-arena-blue.svg">
</p>

---

## What is BridgeBench?

BridgeBench measures how models perform as vibe coding partners. Every task is a software-engineering scenario — source code, diffs, CI logs, API specs, migrations, telemetry, agent sessions — and every deliverable is a question a coding agent would actually face.

V3 is **arena-first**: models compete head-to-head on the same task, three independent model judges choose the stronger answer blind, and every majority decision awards one point and one Elo update. There is no weighted aggregate score and no opaque formula — a ranking is exactly the sum of the match record behind it, and the journal that produced it is replayable line by line.

It's built by [BridgeMind](https://bridgemind.ai), the agentic organization behind BridgeSpace, BridgeVoice, and BridgeAgent. We benchmark models because we ship with them daily — the leaderboard is the same data we use to pick our own teammates.

> **Where did the season engine go?** This repo previously hosted the Season 1 *season-engine* alpha (UI Bench: 10 Three.js tasks scored in a real browser, ranked by community A/B voting). That work is preserved intact on the [`season-engine-alpha`](https://github.com/bridge-mind/bridgebench/tree/season-engine-alpha) branch — its model registry, provider layer, and browser-determinism harness will return as future arenas. The autonomous arena you're looking at replaces it as BridgeBench's core mechanism: same transparency principles, but every ranking now traces to pairwise matches instead of suite scores. Season framing resets with this pivot; nothing measured by the old engine mixes with arena Elo.

## The arenas

Two independent arenas ship today, each with its own task pack, journal, Elo ladder, and leaderboard:

| Arena | What it measures | What a winning answer looks like |
|---|---|---|
| **Reasoning** | Inference depth. Every task is fully determinable from its artifacts — interlocking specs, logs, code, and configs with planted decoy paths. | Derives the one defensible resolution for every numbered deliverable, with the inference chain and artifact citations. |
| **Hallucination** | Epistemic discipline. Tasks are seeded with false premises, missing evidence, fabrication bait (plausible entities that don't exist), conflicting sources, and near-duplicate values. | Answers the supported deliverables exactly, corrects false premises with the contradicting evidence, names precisely what is missing — and never invents entities, values, quotes, or blended figures. |

The two arenas share the arena contract (pairing, blind three-judge panel, Elo) but never share ratings: a model's reasoning Elo says nothing about its hallucination Elo. Judges receive category-specific instructions — the reasoning panel punishes hedging on determinable questions, the hallucination panel weighs fabrication heaviest and treats blanket refusal as an error too.

The same contract expands to security, debugging, and refactoring arenas next.

## Autonomous match lifecycle

1. A seeded scheduler selects one task and two distinct competitors while balancing exposure. The same seed always produces the same schedule.
2. Both competitors receive identical task context and run concurrently. They don't know they're in a match.
3. One exhausted competitor failure forfeits; two failures create a no-contest.
4. Each judge independently receives the task, hidden rubric, and anonymous answers.
5. Explicit model IDs, canonical slugs, provider names, and model-family names are redacted from responses; judges see only `Model A` and `Model B`.
6. A/B order is independently permuted per judge to reduce position bias.
7. Two valid votes decide the winner. Judges never see identities, ratings, costs, or other votes.
8. The winner earns one point. Elo starts at 1000 and uses K=32.
9. The complete result is appended to the journal before reports are rebuilt. Snapshots are derived, never authoritative.

Candidate answers are treated as untrusted data. Judge prompts explicitly reject instructions embedded in answers; structured verdicts are schema validated; malformed verdicts get one retry and then abstain. No generated code or model-provided command is ever executed.

The full protocol — scheduling math, anonymization rules, vote resolution, drift detection — is in [docs/methodology.md](docs/methodology.md).

## Model roster and transport

All requests go through [OpenRouter](https://openrouter.ai) using exact, pinned model slugs. `latest` aliases are prohibited. Before a paid run, the CLI verifies each ID and canonical slug against OpenRouter and confirms that judges still support structured output.

We say this plainly: the arena measures models *through one aggregator's routing*, not direct provider APIs. In exchange, every competitor and judge runs over the identical transport, and OpenRouter's per-generation records (`arena generation <id>`) give independently checkable token and cost accounting for every journal line.

Competitors: GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, Claude Fable 5, Claude Opus 4.8, MiniMax M3, MiniMax M2.7, and Kimi K2.7 Code.
Judges: Gemini 3.1 Pro Preview, Grok 4.5, and GLM 5.2. Judges are not eligible competitors.

## Setup

Requirements: Node.js 20+ and an OpenRouter API key with an account-level spending limit.

```bash
git clone https://github.com/bridge-mind/bridgebench.git
cd bridgebench && npm install
export OPENROUTER_API_KEY='set-this-in-your-shell'

npm run tasks -- validate     # validates the public packs — no key or private overlay needed
npm run models -- validate    # verifies every pinned slug against OpenRouter
```

## Run an arena

```bash
# Default: 12 reasoning matches, reproducible seed, $25 stop boundary
npm run arena -- run

# The hallucination arena — same contract, its own tasks, journal, and Elo
npm run arena -- run --category hallucination

# Custom batch
npm run arena -- run --category hallucination --matches 24 --seed july-calibration --max-cost-usd 40

# Resume the exact deterministic schedule after interruption or budget stop
npm run arena -- run --matches 24 --seed july-calibration --max-cost-usd 40 --resume

# Rebuild reports for both arenas without API calls (or one: --category reasoning)
npm run report

# Maintainers: sync outputs to the bridgebench.ai API (admin key required; idempotent)
npm run tasks -- publish
npm run arena -- publish --category reasoning
```

**Judged runs need the hidden references.** Task prompts are public in this repo; the expected resolutions and comparative rubrics that judges use are not, so they can't be trained against. Runs require `BRIDGEBENCH_PRIVATE_DIR` to point at a private-pack checkout — see [docs/private-packs.md](docs/private-packs.md) for the layout, the contamination guard, and the publish-at-retirement policy. Everything else — validation, report rebuilds, triage, the dashboard's read views — works from the public halves alone.

Results are local, ignored by Git, and kept per arena:

```text
results/<category>/journal.jsonl      # append-only source of truth (category = reasoning | hallucination)
results/<category>/snapshot.json      # derived atomically; delete and rebuild any time
results/<category>/leaderboard.md
```

A repeated schedule is rejected unless `--resume` is explicit. To verify any published ladder yourself, see [docs/replay-elo.md](docs/replay-elo.md).

## Local dashboard

A BridgeMind-branded control surface split into three views — Arena, Leaderboard, and Matches — with a live competitor + anonymous-judge stage during runs, durable match history with raw responses and judge rationales, and an SSE activity feed.

```bash
npm run dashboard
# Open http://127.0.0.1:4317
```

The control plane binds only to `127.0.0.1`. The API key stays in the server process and is never serialized to the browser. State-changing requests require a same-origin JSON request, only one run may be active at once, and the browser renders model output as escaped text.

## Task packs

Both packs hold 12 expert-difficulty tasks across six category-specific clusters (two tasks each). Tasks are deliberately heavyweight — five to eight interlocking artifacts (~9–18k characters) and four to ten numbered deliverables — so a match exercises real deliberation budget instead of a one-screen skim.

**Domain invariant: every task is a coding / software-engineering scenario.** No generic business ops. Public prompts live under `tasks/<category>/public/`; hidden references live in the private overlay. Every journal line records the SHA-256 of both task halves, so task drift is externally detectable.

Cluster definitions, the public/private YAML schemas, and the authoring rules (including how decoys map to disqualifying errors) are in [docs/task-authoring.md](docs/task-authoring.md).

## Debugging & the continuous improvement loop

Every arena and dashboard run writes a structured, key-redacted JSONL log to `results/<category>/logs/`. The triage command analyzes journals for anomalies — failed requests, suspiciously fast responses, truncation, judge abstentions — and a health stop halts runs that are mostly producing failures.

```bash
npm run arena -- run --debug        # mirror every log entry to the console
npm run triage                      # analyze the journal (auto-printed after every run)
npm run arena -- generation gen-... # OpenRouter's ground-truth record for any journaled generation
```

The loop: run → read the auto-printed health report → chase flags with the run log → fix the task, prompt, or model policy → rerun with a fresh seed → compare triage reports.

## Repository layout

```
bridgebench/
├── src/
│   ├── cli.ts             # models · tasks · arena run/publish/triage/generation · report
│   ├── arena.ts           # match loop: forfeits, health stop, budget stop
│   ├── scheduler.ts       # seeded, exposure-balanced deterministic scheduling
│   ├── judges.ts          # anonymization, per-judge A/B permutation, majority vote
│   ├── tasks.ts           # pack loader + public/private overlay resolution
│   ├── elo.ts / store.ts / report.ts / triage.ts
│   └── dashboard/         # localhost-only control plane (SSE)
├── tasks/
│   ├── reasoning/public/       # 12 public task prompts
│   └── hallucination/public/   # 12 public task prompts
├── ui/                    # local dashboard SPA (React + Vite)
├── test/                  # offline vitest suites (mock gateway, no credits spent)
└── docs/                  # methodology · task authoring · private packs · replay Elo
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

Tests use a mock OpenRouter gateway and never spend credits — they pass from a fresh public clone with no API key and no private overlay. Live catalog validation and arena runs are operator-invoked only.

## Contributing

BridgeBench is open source and open to builders:

- **Propose tasks.** Public halves are authored in the open; hidden references go through a private channel so they stay uncontaminated. Start from [docs/task-authoring.md](docs/task-authoring.md) and open an issue.
- **Audit a ladder.** Every published ranking replays from its journal — [docs/replay-elo.md](docs/replay-elo.md). If a number doesn't reproduce, open an issue.
- **Extend the contract.** New arenas (security, debugging, refactoring) reuse the same match lifecycle; the season-engine branch holds a provider layer and browser harness earmarked for future suites.

## License

[MIT](LICENSE)

---

<p align="center">
  <img src="assets/bridgemind-symbol.png" alt="BridgeMind" width="40"><br/><br/>
  Built by <a href="https://bridgemind.ai">BridgeMind</a> — the agentic organization.<br/>
  <sub>Ship software at the speed of thought. This is vibe coding.</sub>
</p>
