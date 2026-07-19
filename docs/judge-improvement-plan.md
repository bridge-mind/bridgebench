# Judge Improvement Plan — panels and evals

Status: PROPOSED (2026-07-16). Owner: arena engine.
Evidence base: full audit of the production journal (319 matches, 720 judge
votes, Jul 13–15 2026) plus two deep code reviews of the v3.1.0-alpha.14
engine (methodology `arena-v0.4.0`). Numbers cited below come from
`arena_judge_votes` / `arena_matches` in `bridgebench-db-prod`.

Scope: the seven judged arenas. **Speed is out of scope by design** — it is a
pure latency race with no judge panel. Only measurement-quality nits for speed
appear in Phase 3.

Guiding metrics (report per phase, per category):

| Metric | Today | Target |
| --- | --- | --- |
| Split-verdict rate (overall) | 30.4% (reasoning 48.4%) | < 20% (no category > 30%) |
| Seat-A pick rate per judge | GLM 62.1%, Grok 59.6%, Gemini 51.7% | 48–52% for every seated judge |
| Confidence signal (avg conf, dissent vs majority) | indistinguishable; Gemini ≥0.9 on 96% of votes | dissent conf measurably lower; Brier tracked |
| Violations usage | 0.07 per verdict | rubric-linked, populated on every decisive verdict |
| Verdicts decided by presentation (spot audit) | unknown | 0 in a 50-verdict sample |

---

## Phase 1 — verdict contract and tie handling (highest impact)

### 1.1 Add `TIE` and `ABSTAIN` verdicts

- `winner` enum becomes `MODEL_A | MODEL_B | TIE`; a judge may also return
  `ABSTAIN` with a machine-readable reason (`reference-conflict`,
  `insufficient-evidence`, `ambiguous-task`).
- Files: `src/contracts/journal.ts` (verdict transport schema),
  `src/judges.ts` (`JUDGE_SYSTEM_BASE` tie instruction currently forces a
  pick at ~0.5 confidence), aggregation in `JudgePanel.judge()`.
- Aggregation: majority of non-tie votes still wins; a majority of TIE votes
  or a 1–1–TIE panel triggers adjudication (1.2) instead of no-contest.
- Why: 30.4% of judged matches split; reasoning is a near coin-flip at 48.4%.
  Forced choice converts genuine equivalence into K=32 Elo movement.

### 1.2 Adaptive adjudication instead of automatic points

- On a 2–1 split, a TIE-majority, or any panel containing an abstention:
  seat the next two eligible judges from the hash ranking (5-judge panel,
  best of 5). Only if the expanded panel still cannot produce a 3-vote
  majority does the match void as no-contest.
- Files: `src/seating.ts` (ranking already produces a full ordering — take
  ranks 4–5), `src/judges.ts` aggregation, `src/arena.ts` outcome mapping.
- Cost guard: expanded panels bill against the run's `maxCostUsd` like any
  judge call; expect ~30% of matches to add two judge calls.

### 1.3 Typed decisive difference (make the hard-reason rule enforceable)

- Replace the prose-only `rationale` gate with a required structured object:

  ```
  decisiveDifference: {
    deliverableId: string,   // must exist in the task's deliverable list
    winnerClaim: string,
    loserError: string,
    artifactIds: string[],   // must exist in task.public.artifacts
    rubricCriterion: 'correctness' | 'grounding' | 'constraintHandling' | 'completeness'
  }
  ```

- Validate IDs at parse time (`src/openrouter.ts` `parseJudgeVerdict`); an
  unresolvable deliverable/artifact ID counts as a malformed verdict and
  consumes one of the judge's two attempts.
- TIE verdicts carry no decisive difference but require a per-criterion
  equivalence note.
- Why: today validation only checks the rationale is non-empty ≤ 4000 chars —
  "Model A was more complete" passes. This also fixes the dead `violations`
  field by folding it into rubric-linked structure.

### 1.4 Wire confidence into something or drop it

- Keep collecting confidence but define it: "estimated probability the chosen
  side is substantively better under this rubric." Track per-judge Brier
  score against final (expanded-panel) outcomes in triage
  (`src/triage.ts`) and publish it on the methodology page.
- Do NOT weight votes by raw confidence until a judge shows calibration
  (today Gemini reports ≥ 0.9 on 96% of votes; dissent confidence is
  indistinguishable from majority confidence for all three judges).

Acceptance for Phase 1: schema + engine + verifier updated together
(`src/verification.ts` must replay TIE/adjudicated panels); a mock-gateway
run demonstrates a 2–1 match escalating to a 5-judge panel; split-rate and
Brier dashboards exist in triage output.

---

## Phase 2 — panel composition and bias control

### 2.1 Position-bias monitoring and gating

- Add a standing triage report: per judge, seat-A pick rate and the
  controlled seat-swing (pick rate for the same competitor in seat A vs B).
  Alert when |swing| > 8 pts over a 50-vote window.
- Production evidence: GLM 5.2 swings +16.9 pts and Grok 4.5 +15.3 pts on
  Claude Fable 5's seat; Gemini 3.1 Pro is seat-neutral (−1.5).
- Enforcement option (Phase 2b): judges exceeding the swing threshold get
  benched for the category until they pass a calibration set (2.3).

### 2.2 Counterbalanced seating instead of independent coin flips

- Replace the per-judge hash bit (`shouldSwap`, `src/judges.ts:67-70`) with a
  balanced assignment: across the 3 (or 5) seated judges, seat orders are
  assigned so each competitor appears in seat A for at least ⌊n/2⌋ judges.
  Keep it deterministic from `matchId` so replay still works.
- Why: independent bits give all-same-order panels 25% of the time on a
  3-judge panel; combined with two seat-biased judges, that is a measurable
  thumb on the scale.

### 2.3 Gold-task calibration sets per category

- Build 10–20 retired/authored tasks per category with known verdicts,
  each in four variants: terse-vs-verbose rewrite of the same content, and
  both seat orders.
- A judge's category calibration = accuracy on gold verdicts + invariance
  across the length and seat perturbations. Run on every new judge model,
  every prompt-policy change, and monthly.
- Store results next to the model registry so seating (2.4) can read them.

### 2.4 Expand and de-conflict the judge pool

- Add at least two judge-only models from vendors absent from the competitor
  roster (today 4 of 5 pool members also compete on the ladder; vendor
  exclusion already prevents direct conflicts but whole panels can consist
  of ladder rivals).
- Prefer calibrated judges in seating: rank eligible judges by
  (calibration pass, then hash) rather than hash alone (`src/seating.ts`).
- Keep the fail-closed rule; with a 7-model pool, vendor exclusion plus a
  5-judge adjudication panel still seats.

Acceptance for Phase 2: triage emits seat-swing and calibration tables; a
seeded run shows counterbalanced seat orders; pool has ≥ 2 judge-only
additions with passing calibration.

---

## Phase 3 — eval content (what judges actually grade against)

Cross-cutting changes first, then per-category.

### 3.1 Machine-readable rubrics (replace prose private halves)

- Extend the private task schema (`src/contracts/tasks.ts`) with structured
  deliverables:

  ```
  deliverables: [{
    id, question,
    classification,        // category-specific enum, e.g. SUPPORTED | FALSE_PREMISE | NOT_DETERMINABLE
    expectedAnswer,        // short canonical answer or verdict
    evidenceArtifactIds,
    disqualifiers: [{ id, description }],
    weight                 // 1-3
  }]
  ```

- Judges then score per deliverable before the overall verdict; the typed
  decisive difference (1.3) must reference a deliverable ID. Keep the
  existing prose fields during migration; hash both.

### 3.2 Two-pass judging: derive first, reconcile second

- Pass 1: judge answers each deliverable from public artifacts only (no
  hidden reference). Pass 2: reference revealed; judge must flag and explain
  any disagreement with the reference rather than silently adopting it.
- Why: all three judges currently share one answer key, making
  reference-author errors a correlated panel-wide failure. Disagreement
  flags become a standing audit queue for task quality.
- Cost: roughly doubles judge tokens; apply first to the two noisiest
  categories (reasoning, hallucination) and expand if split rates drop.

### 3.3 Per-category prompt and task fixes (`src/judges.ts`, task packs)

| Category | Fix |
| --- | --- |
| reasoning | Score conclusion and derivation separately per deliverable. Define "fully determinable" as the requested decision being determinable — do not punish calibrated residual uncertainty. Disqualifiers apply only when affirmatively adopted. First target for TIE + two-pass. |
| hallucination | Classification-first: SUPPORTED / FALSE_PREMISE / NOT_DETERMINABLE per deliverable, then answer accuracy. Absence claims grounded only when an artifact declares exhaustiveness. Weight core fabrications over incidental imprecision (kills the hidden length penalty of "verify every factual claim"). |
| security | Add "authorized defensive analysis of fictional code" framing to competitor AND judge prompts to cut refusals. Require structured findings: source, sink, guards, reachable preconditions, impact, severity basis, patch coverage. Publish refusal rate, provider-failure rate, and quality as separate metrics. Rerun the ladder under one methodology (current standings mix forfeit-era and no-contest-era scoring). |
| bullshit | Define NONSENSE strictly (conceptual/unit/causal/ontology contradiction) vs merely-unsupported. Weight premise classification above the redirect answer. Consider renaming the published category "Premise Integrity". |
| refactoring | **Prompt bug, fix immediately**: judge prompt asserts "exactly one rewrite preserves behavior" but tasks contain multiple independent equivalent rewrites. Remove the global count; require a concrete witness input for every `changes-behavior` verdict and declared path coverage for `behavior-preserving`. |
| debugging | Define root cause as the earliest artifact-supported defect whose correction breaks the failure chain. Score diagnosis and fix adequacy independently. Bound "no regression" to constraints declared in artifacts. |
| generation | Decide the construct: rename to "Spec Conformance" (honest about what it measures — nothing is executed), or make it real generation with hidden deterministic tests and judges only for non-testable qualities. Remove the "exactly one resolution" prior unless the task declares it. |
| speed | (Judge-free by design — measurement nits only.) Median of ≥ 3 paired trials; include retry backoff in totals; void exact ties instead of awarding seat A; align the category tagline with the actual total-time rule. |

### 3.4 Task-pack hygiene

- Sweep public artifacts for answer leakage (several sampled tasks contain
  comments that name the correct candidate/sink/fix outright).
- Version the deliverable IDs so journaled decisive differences stay
  resolvable after task edits.

---

## Phase 4 — integrity and drift cleanup (small, do alongside)

1. Verifier: re-check that each vote's `verdict.winner` label resolves to
   `winnerModelId` via the deterministic per-judge swap; reject `forfeit`
   rows in `arena-v0.4.x` journals (`src/verification.ts`).
2. Docs: methodology.md still says `arena-v0.3.0`; speed tagline claims
   TTFT/throughput decide winners; `ModelRegistryEntry.judgeRequest` comment
   still describes self-judging. Fix all three.
3. Anonymization: add bare "Grok"/"GLM" to family patterns; scope redaction
   to identity-claim contexts so legit technical uses of Sol/Luna/Claude/Opus
   in answer content stop being destroyed.
4. No-contest selection-bias watch: triage report of per-model failure rate
   by category, so a model that "fails out" of hard tasks is visible even
   though it no longer takes losses.

---

## Sequencing and effort

| Phase | Items | Est. effort | Dependency |
| --- | --- | --- | --- |
| 1 | TIE/ABSTAIN, adjudication, typed decisive difference, Brier tracking | ~1 week engine + verifier + UI copy | none — schema change gates everything else |
| 2 | bias monitoring, counterbalanced seating, gold sets, pool expansion | ~1 week + ongoing calibration ops | 1 (verdict schema) |
| 3 | machine rubrics, two-pass, category prompts, task hygiene | ~2 weeks, category-by-category | 1; 3.3 refactoring/security prompt fixes can ship immediately |
| 4 | verifier + docs + redaction cleanup | ~2 days | none |

Ship order for immediate wins (this week): refactoring "exactly one" prompt
fix, security defensive framing, doc drift fixes, seat-swing triage report.
Everything else follows the phase order.

Every phase bumps the engine version and `judgePromptPolicyHash`, ships via
the vendored-tarball ritual (see `BridgeMind/Notes/bridgebench-judge-hard-reason-rule.md`),
and never mixes methodology versions in one ladder — Phase 1 requires a
methodology bump to `arena-v0.5.0` and fresh ladders (or a journal replay
under the new fold where outcomes are unaffected).
