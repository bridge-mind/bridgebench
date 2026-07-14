# Methodology — the arena contract

Every ranking BridgeBench publishes is the fold of an append-only match journal. This document specifies the full protocol that produces a journal line, so any published ladder can be audited or reproduced. The engine stamps every line with `methodologyVersion` (currently `arena-v0.3.0`, `src/contracts/categories.ts`); results from different methodology versions never mix silently.

## What this contract establishes

| Control | What it establishes | Deliberate limit |
| --- | --- | --- |
| Versioned run manifest and seeded scheduler | The planned roster, tasks, policies, ordering inputs, and schedule are reproducible | Model responses are not expected to be byte-identical across new API calls |
| Byte-identical public context | Both competitors receive the same task evidence | Provider routing and model runtime behavior remain external dependencies |
| Redaction, per-judge permutation, and isolated votes | Recorded decisions follow the benchmark's anonymity and position-bias controls | Model judges can still have shared biases or make a poor qualitative choice |
| Task hashes and append-only journal | Claimed inputs can be tied to each line and inconsistent drift detected | The files do not authenticate the publisher or prevent a coordinated rewrite; active hidden references remain unavailable until retirement |
| Fail-closed verifier | Schema, ordering, panel outcome, points, costs, manifests, and Elo replay consistently | Internal consistency does not independently prove semantic answer quality |

The benchmark is reproducible at the **evidence and scoring** layer, not by
promising deterministic model prose. [Reviewing BridgeBench](reviewing-bridgebench.md)
walks through those guarantees and limitations using the bundled fixtures.

## Run identity and scheduling

A **run** is deterministic from a versioned manifest:

- The manifest binds the category, seed, match count, engine and methodology versions, sorted competitor and judge slugs, request policies, task hashes, and competitor/judge prompt-policy hashes. Runs may select an explicit roster of at least two unique, enabled competitors; omitting one selects every enabled competitor.
- The run ID is a SHA-256 prefix of the canonical manifest. Every journal line records the full manifest hash.
- The scheduler builds all `(competitorA, competitorB, task)` combinations and greedily picks the next match by lowest exposure, ordered by: max per-model exposure → summed model exposure → task exposure → pair exposure. Ties break by a seeded mulberry32 PRNG, so balance is reproducible, not incidental (`src/scheduler.ts`).
- Which competitor sits on side A is randomized per match from the same seeded stream.
- Match IDs are stable hashes; re-running a schedule with `--resume` skips journaled match IDs exactly. Repeating a completed schedule without `--resume` is rejected.

## Competitor execution

- Both competitors receive byte-identical context: a category-specific system prompt plus the task title, summary, prompt, and all public artifacts inline (`src/tasks.ts`). They are never told they are in a match, and the system prompt forbids revealing model identity.
- Requests run concurrently over OpenRouter with pinned slugs (`latest` aliases prohibited). Before any paid run the CLI re-validates the selected competitors and all three judges against the live catalog, and confirms judges still support structured output.
- Transport is fail-closed: 3 attempts on retryable errors (classified by HTTP status first, message text second), per-request watchdog timeouts, and a hard prompt-size cap. A failed competitor response — provider outage, timeout, empty completion — **voids the match as a no-contest**: no winner, no point, no Elo movement, and the surviving answer is never judged. An infrastructure failure is not a quality signal, so nobody scores off an opponent's outage. (Runs journaled before 2026-07-14 may contain historical `forfeit` outcomes, which awarded the survivor a win under the old rule.)

## Blind three-judge panel

Judged matches go to a fixed, cross-vendor panel of three model judges. A panel judge may also compete in the arena (a dual-role model): its own matches are judged by the same fixed panel under the full blind protocol below, so it votes on its own anonymized answer exactly as it votes on any other. The redaction and permutation controls bound — but cannot fully eliminate — self-preference on those matches; the match record makes every such vote auditable. Independence is enforced structurally:

1. **Anonymization.** Before an answer crosses into a judge prompt, explicit competitor identity terms (IDs, canonical slugs, display names, vendors) and family names (Claude, GPT, Kimi, Opus, …) are redacted (`src/judges.ts`). Judges see only `Model A` and `Model B`.
2. **Per-judge order permutation.** Whether A/B are swapped for a given judge is a deterministic hash of `matchId|judgeId`, so position bias can't systematically favor one side and the permutation is replayable.
3. **Isolation.** A judge receives the task, the hidden reference (expected resolution, required evidence, disqualifying errors, rubric), and the two anonymous answers — never identities, ratings, costs, or the other judges' votes.
4. **Forced choice, structured output.** Verdicts are JSON-schema enforced (`MODEL_A` or `MODEL_B`, confidence, rationale, four-criteria commentary, violations). A malformed verdict gets one retry, then the judge **abstains**.
5. **Majority.** Two valid votes for the same side decide the match. Agreement is recorded as `unanimous` (three winner votes), `split` (exactly two winner votes, including a 2–0 panel with one abstention), or `insufficient` (no majority → no-contest).

Judge prompts are category-specific: the reasoning panel treats hedging on a determinable deliverable as an error and disqualifying errors as near-decisive; the hallucination panel weighs fabrication heaviest and also penalizes refusing deliverables the artifacts do support.

The hidden reference is **judging context, not an oracle** — no deterministic task score picks the winner, and no model-generated code is ever executed.

## Scoring

- A win awards exactly one point and one Elo update. Elo starts at 1000 with K=32 (`src/elo.ts`). No-contests — including matches voided by a failed response — change nothing.
- Each arena keeps its own ladder. Reasoning Elo and hallucination Elo never mix.

## The journal is the source of truth

- Every completed match is appended to `results/<category>/journal.jsonl` **before** any report is rebuilt. Snapshots and leaderboards are derived atomically and may be deleted and rebuilt at any time.
- Every line records: methodology version, run ID and manifest hash, seed, schedule index, the task's ID/version/cluster and the SHA-256 of **both** task halves (`publicHash`, `privateHash`), both full competitor responses with token/cost/latency accounting, the panel's votes and rationales, `eloBefore`/`eloAfter` for both models, and the match cost.
- The task hashes make drift externally detectable: if a task file changes after a match ran, the recorded hash no longer matches the file. When a retired pack's private halves are published, `privateHash` proves they are byte-identical to what the judges actually used.
- OpenRouter generation IDs are journaled per response; `npm run arena -- generation <id>` fetches the provider's own token/cost record for independent cross-checking.

`npm run arena -- verify` schema-validates every line, checks outcome and panel invariants, replays points and Elo, and validates referenced run manifests. Reports and resume state use the same verified fold. See [replay-elo.md](replay-elo.md) for the complete workflow.

## Adversarial-input posture

Candidate answers are treated as untrusted data end to end: judge prompts explicitly refuse instructions embedded in answers, verdicts are schema-validated, the dashboard renders model output only as escaped text, structured logs redact API keys, and journal/log/snapshot files are written mode 0600.

## Operational guards

- **Budget stop**: spend is checked before each match against `--max-cost-usd` (default $25); a stopped run resumes deterministically with `--resume`.
- **Cancellation**: Ctrl-C or the dashboard cancel action aborts active competitor and judge requests, emits `run.cancellation-requested` followed by terminal `run.cancelled`, and stops before the next match. Completed journal lines remain resumable; a partial match is never appended.
- **Health stop**: once ≥4 matches complete and ≥50% contain a failed competitor response, the run halts instead of journaling a batch of silent no-contests (`--no-health-stop` overrides).
- **Triage**: every run auto-prints an anomaly report (failed requests, suspiciously fast responses, low output, truncation, unreported reasoning tokens, zero-cost accounting, judge abstentions) — `npm run triage` re-analyzes any journal.
