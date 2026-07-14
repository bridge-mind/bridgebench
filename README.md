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
  <a href="https://bridgebench.ai">Leaderboard</a> &nbsp;&bull;&nbsp;
  <a href="#review-the-benchmark">Review</a> &nbsp;&bull;&nbsp;
  <a href="#how-a-match-becomes-a-ranking">Methodology</a> &nbsp;&bull;&nbsp;
  <a href="#the-arenas">Arenas</a> &nbsp;&bull;&nbsp;
  <a href="docs/README.md">Docs</a> &nbsp;&bull;&nbsp;
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-8A63D2.svg">
  <img alt="Season One" src="https://img.shields.io/badge/season_one-arena-blue.svg">
</p>

---

## What is BridgeBench?

BridgeBench measures how models perform as vibe coding partners. Every task is
a software-engineering scenario built from artifacts such as source code,
diffs, CI logs, API specs, migrations, telemetry, and agent sessions.

Models compete head-to-head on the same task. Three independent model judges
compare their answers blind, a majority selects the stronger response, and the
winner earns one point plus one Elo update. The append-only match journal is
the source of truth; leaderboards and API responses are derived views.

BridgeBench is built by [BridgeMind](https://bridgemind.ai), the agentic
organization behind BridgeSpace, BridgeVoice, and BridgeAgent. We use the same
benchmark data to choose models for our own work.

## Start with the path you need

| Goal | Start here |
| --- | --- |
| Understand and audit a result | [Reviewing BridgeBench](docs/reviewing-bridgebench.md) |
| Understand the full arena contract | [Methodology](docs/methodology.md) |
| Run paid matches or operate the dashboard | [Operator guide](docs/operator-guide.md) |
| Author tasks or change the engine | [Contributing](CONTRIBUTING.md) |
| Find a specific concept | [Documentation index](docs/README.md) or [glossary](docs/glossary.md) |

## Review the benchmark

Requirements: Node.js 20.19 or newer and npm 10 or newer.

```bash
git clone https://github.com/bridge-mind/bridgebench.git
cd bridgebench
npm ci
npm run review
```

`npm run review` is the shortest credential-free audit path. It:

1. checks documentation links, navigation, commands, and fixture references;
2. validates all 144 public tasks and their pack invariants;
3. verifies a bundled journal line against its run manifest;
4. replays the majority outcome, point, and Elo update.

It needs no API key, private task overlay, network request, or paid model call.
The fixture is synthetic and tests the audit mechanism, not model quality.
Follow the [reviewer walkthrough](docs/reviewing-bridgebench.md) to connect
that mechanism to a real public task and published results.

## How a match becomes a ranking

```text
public task ─┐
             ├─> two competitors ─> anonymous answers ─┐
hidden rubric┘                                         ├─> three blind judges
                                                      │
                                                      └─> majority decision
                                                               │
                                                               v
run manifest ─────────────────────────────────────> journal + Elo
                                                               │
                                                               v
                                                   verified leaderboard
```

1. A seeded scheduler selects a public task and two distinct competitors while
   balancing exposure.
2. Both competitors receive byte-identical task context and run concurrently.
3. Each judge receives the task, hidden reference, and two anonymous answers.
4. Model and provider identities are redacted, and answer order is independently
   permuted for each judge.
5. Two valid votes decide the winner. One exhausted competitor failure is a
   forfeit; two failures or no majority produce a no-contest.
6. A decided match awards one point and updates Elo from an initial rating of
   1000 with K=32.
7. The complete evidence record is appended before reports are rebuilt.

Candidate answers are untrusted input. Judge prompts reject embedded
instructions, verdicts are schema validated, malformed verdicts abstain after
one retry, and model-provided code or commands are never executed.

The [methodology](docs/methodology.md) specifies scheduling, anonymization,
voting, failure outcomes, and replay rules in full.

## The arenas

Each arena has its own task pack, journal, Elo ladder, and leaderboard. Ratings
never cross categories.

| Arena | What it measures | A strong answer |
| --- | --- | --- |
| **Reasoning** | Inference across interlocking software artifacts with planted decoys. Every deliverable is determinable from the provided evidence. | Derives the defensible resolution, explains the inference chain, and cites the controlling artifacts. |
| **Hallucination** | Epistemic discipline under false premises, missing evidence, fabrication bait, conflicts, and near-duplicate facts. | Answers supported items, corrects false premises, identifies missing evidence precisely, and does not invent. |
| **Security** | Defensive analysis of fictional code that hides one real, reachable vulnerability among benign look-alikes, false positives, and shallow patches. No code is executed. | Proves the reachable source-to-sink or guard-bypass chain with cited evidence and calibrated severity, and declines to flag the benign traps. |
| **BullShit** | Premise integrity under seeded nonsense — fabricated concepts, crossed domains, impossible quantities, reversed causality, pseudoscience, and loaded assumptions mixed with legitimate deliverables. | Names exactly what is nonsensical and why, corrects the premise to the nearest legitimate question and answers it, and still answers the sound deliverables instead of blanket-refusing. |
| **Refactoring** | Behavior preservation under a transformation goal, with candidate rewrites that subtly change ordering, scope, contracts, or an edge case. | Traces equivalence across every affected path, cites the location and mechanism, and flags the rewrite that silently changes observable behavior. |
| **Debugging** | Root-cause isolation from a failing system's evidence, among red-herring causes and shallow fixes. | Traces symptom to origin with cited evidence, names the one defensible root cause, and picks the fix that holds without regressing. |
| **Generation** | Specification conformance across candidate implementations, where each near-miss violates one stated constraint or edge case. | Cites the exact spec clause and the distinguishing input, and identifies the implementation that meets every requirement. |
| **Speed** | Raw latency: both models answer the same task and the faster completion wins. Decided by measured time-to-first-token and throughput — no judges. | Answers correctly and efficiently; the arena records TTFT and tokens-per-second and awards the win to the lower total completion time. |

Each judged public pack contains 18 expert tasks across six category-specific
clusters (three per cluster); the Speed pack contains 18 public-only workload tasks. See
[Task authoring](docs/task-authoring.md) for their schemas, clusters, and
enforced balance.

## What evidence backs a result?

| Evidence | Role | What a reviewer can check |
| --- | --- | --- |
| Public task | Exact prompt and artifacts sent to both competitors | Content, version, category, cluster, and `publicHash` |
| Run manifest | Identity of the run | Seed, roster, task hashes, prompt policies, methodology, and engine version |
| Match journal | Append-only execution record | Full responses, judge votes and rationales, outcome, cost, point, and Elo before/after |
| Hidden reference | Expected resolution, evidence requirements, traps, and rubric | Its hash while active; its full contents after pack retirement |
| Snapshot and leaderboard | Convenient derived views | Rebuild them only after the journal verifies |

`arena verify` validates every journal line and replays Elo before reports,
resume state, or publishing trust it. Read [Replay the Elo](docs/replay-elo.md)
for the algorithm and exact audit command.

### What verification does not prove

Journal verification proves internal consistency and detects inconsistent
edits, within-run reordering, task/manifest mismatch, and incorrect rating
math. It does not authenticate the publisher or rule out a coordinated rewrite
of the journal and manifest. It also cannot prove that a model judge made the
best qualitative choice, that hidden references never reached a third-party
provider, or that one aggregator represents direct provider behavior.

All requests currently travel through OpenRouter using pinned model slugs.
Active hidden references are sent to the configured judges and are withheld
from the public repository until their pack retires. The
[reviewer guide](docs/reviewing-bridgebench.md#what-the-evidence-proves) and
[private-pack boundary](docs/private-packs.md) describe these limitations
without claiming more than the evidence supports.

## Repository map

```text
bridgebench/
├── src/                         arena, judging, verification, reports, CLI
├── tasks/<category>/public/     public task packs
├── test/fixtures/               deterministic journals and run manifests
├── ui/                          localhost dashboard
├── docs/                        reviewer, protocol, authoring, and operator guides
└── CONTRIBUTING.md              code, task, audit, and documentation workflow
```

Canonical executable sources:

- Model roster and request policy: [`src/models.ts`](src/models.ts)
- Category and methodology constants: [`src/contracts/categories.ts`](src/contracts/categories.ts)
- Task loading and pack invariants: [`src/tasks.ts`](src/tasks.ts)
- Journal verification and replay: [`src/verification.ts`](src/verification.ts)

## Develop and contribute

The full public-clone quality gate uses a mock OpenRouter gateway and requires
no model API credentials:

```bash
npm ci
npx playwright install chromium
npm run check
```

Paid arena commands are operator-invoked only and are not part of pull-request
validation. BridgeBench accepts code, public task proposals, methodology
audits, and documentation fixes. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Project history

This repository previously hosted the Season 1 `season-engine` alpha: ten
Three.js tasks scored in a browser and ranked by community A/B voting. Most
of that engine — the other nine tasks and the live-model runner — remains on
the
[`season-engine-alpha` branch](https://github.com/bridge-mind/bridgebench/tree/season-engine-alpha).
One task, the lava lamp (`s1-lava-lamp-redux`), has been restored to `main`
as a working slice — see [UI Bench](docs/ui-bench.md). Its results never mix
with arena Elo.

## License

[MIT](LICENSE)

---

<p align="center">
  <img src="assets/bridgemind-symbol.png" alt="BridgeMind" width="40"><br/><br/>
  Built by <a href="https://bridgemind.ai">BridgeMind</a> — the agentic organization.<br/>
  <sub>Ship software at the speed of thought. This is vibe coding.</sub>
</p>
