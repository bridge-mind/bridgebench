# Reviewing BridgeBench

BridgeBench is designed so a technical reviewer can trace a ranking from the
public task through the match evidence and replay the rating math without
running a model or receiving private credentials.

This guide is the shortest complete review path. The
[methodology](methodology.md) remains the canonical protocol.

## Review in one command

From a fresh clone:

```bash
npm ci
npm run review
```

The command is offline and requires no API key or private overlay.

| Check | Evidence used | Failure means |
| --- | --- | --- |
| Documentation | Local Markdown files and `package.json` | A link, heading, documented command, fixture path, or docs navigation path drifted |
| Public task packs | All files under `tasks/*/public/` | A schema, category, cluster balance, filename, uniqueness, or prompt-budget invariant failed |
| Journal structure | `test/fixtures/journals/valid.jsonl` | The match no longer satisfies the current journal contract |
| Run identity | The matching manifest under `test/fixtures/journals/runs/` | The journal line is not bound to the expected schedule and policy inputs |
| Outcome and Elo | Recorded votes, winner, point, and ratings | The majority outcome or rating transition does not replay exactly |

The included journal is deliberately synthetic. It proves that the public
audit mechanism works; it is not presented as evidence about a real model.

## Follow one match

Use these complementary examples:

- [`stateful-retry-budget.yaml`](../tasks/reasoning/public/stateful-retry-budget.yaml)
  is a real public task and shows the exact task shape competitors receive.
- [`valid.jsonl`](../test/fixtures/journals/valid.jsonl) is the compact,
  deterministic match used by the verifier.
- [The matching run manifest](../test/fixtures/journals/runs/run-bcdf984dc74998a7c083.json)
  binds the fixture to its seed, roster, task hashes, prompt policies,
  methodology, and engine version.

The real task and synthetic match are intentionally separate. Public tasks
evolve as packs rotate; the verifier fixture stays small and deterministic so
contract regressions are obvious.

### Task and run identity

Production `task` objects record the task ID, version, category, cluster, and
the SHA-256 hashes of the exact public and private YAML used for the match. The
`runManifestHash` binds the journal line to the versioned run manifest. This
small synthetic fixture uses obvious `public-fixture` and `private-fixture`
stand-ins so it tests the contract without pretending to contain a production
task.

This lets a reviewer detect task or policy drift without trusting a
leaderboard snapshot.

### Competitor evidence

`competitors.responseA` and `competitors.responseB` retain:

- the complete response text;
- success or failure status;
- generation ID;
- token counts, cost, latency, and finish reason.

Both competitors receive the same public task context. A single exhausted
competitor failure is a forfeit; two failures produce a no-contest.

### Blind panel evidence

`panel.votes` contains all three structured verdicts, including each rationale,
criteria assessment, resolved winner, and completion metadata. Judges receive
anonymous answers in independently permuted A/B order. They never receive
ratings, costs, other votes, or the competitors' canonical identities.

Two valid votes for the same competitor decide the match. The recorded
`agreement` must match the vote count.

### Point and Elo

Every decided match awards one point and one Elo update. Ratings start at 1000
and use K=32. The fixture starts both competitors at 1000, records a unanimous
win for model A, and therefore moves the ratings to 1016 and 984.

`arena verify` recomputes the outcome and the `eloBefore`/`eloAfter` transition
in journal order. Read [Replay the Elo](replay-elo.md) for the formula and
per-line checks.

## Audit an overall result

Auditing an overall result requires seven independently verified judged
arenas; Speed does not participate. Verify every source arena first, then pass
only observed, publisher-normalized arena contributions to the public
[`buildOverallLeaderboard`](../src/overall.ts) scorer. Each contribution must
carry a positive `rankedMatches` count of ladder-eligible decisions
(`ranked !== false` and a winner). No-contests and exhibitions do not count. A
zero-match Elo of 1000 is an initialization prior and must be omitted, not
submitted as evidence. The scorer validates the supplied shape; it does not
inspect the source journals or prove the count.

The scorer provides a compact audit gate:

- `coverage.observed` must equal `coverage.required` (7) before a model is
  ranked;
- a complete model has `status: "ranked"`, a numeric `overallScore`, and a
  numeric `rank`;
- an incomplete model has `status: "provisional"`, `overallScore: null`, and
  `rank: null`;
- `missingCategories` identifies every absent arena in canonical order.

The unrounded arithmetic mean weights the seven supplied arena contributions
equally; `rankedMatches` establishes eligibility but does not weight the mean.
Ranked entries sort by score, then display name and model ID, with distinct
ordinal ranks for exact ties. Provisional entries follow in identity order;
their partial scores and coverage never order them as performance.

Publisher-defined per-arena normalization (for example sample-size or
reliability adjustment) is outside the scorer. An overall result is therefore
reproducible only when the publisher also discloses or version-controls its
normalized inputs or transformation. Review that source transformation and
the journals separately; the public scorer alone is not an end-to-end replica
of a hosted leaderboard.

## Inspect the bundled match visually

The localhost dashboard can load a separate deterministic fixture so you can
inspect the public task, responses, judge rationales, and leaderboard without
an API key.

macOS or Linux:

```bash
BRIDGEBENCH_RESULTS_DIR=test/fixtures/dashboard-results npm run dashboard
```

PowerShell:

```powershell
$env:BRIDGEBENCH_RESULTS_DIR = "test/fixtures/dashboard-results"
npm run dashboard
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317), then use **Leaderboard**
and **Matches**. Treat the fixture as review-only and do not start a run; this
command does not place the dashboard itself into a read-only mode. The
dashboard binds to localhost, keeps API credentials in the server process, and
renders model output as escaped text.

## Audit a published ladder

1. Download the category journal from
   [bridgebench.ai](https://bridgebench.ai) and obtain its matching `runs/`
   manifests.
2. Keep the manifests in a sibling `runs/` directory or pass
   `--manifests-dir <path>`.
3. Verify the journal:

   ```bash
   npm run arena -- verify --category reasoning --journal ./journal.jsonl
   ```

4. Inspect the first failing line if verification stops.
5. Compare each journaled `publicHash` with the raw public task YAML. After a
   pack retires, compare `privateHash` with the published private half too.
6. Review votes and rationales qualitatively; deterministic verification
   cannot decide whether a judge's preference was substantively correct.

To rebuild local derived views after verification, place the journal and
manifests under `results/<category>/` and run `npm run report`.

## What the evidence proves

| Evidence or control | What it supports | What it cannot establish |
| --- | --- | --- |
| Seeded scheduler and run manifest | The planned schedule, roster, policies, versions, and task hashes are bound to a stable run ID | That a new model call will return byte-identical prose |
| Public/private task hashes | The exact task halves used by a match can be identified and drift detected | The contents or quality of an active hidden reference before retirement |
| Blind structured votes | The recorded winner follows the visible panel votes and anonymity controls | That model judges are unbiased or selected the objectively best answer |
| Append-only journal verification | Schema, ordering, majority outcome, point, cost totals, and Elo transitions are internally consistent | Publisher identity, an external timestamp, or protection against a coordinated journal-and-manifest rewrite |
| OpenRouter generation IDs | Provider routing and accounting can be cross-checked with the transport record | Direct-provider equivalence or provider retention behavior |
| Published retired references | The hidden half can eventually be hashed and reviewed against the journal | That no third party retained an active reference while it was in use |

BridgeBench measures models through OpenRouter, not through direct provider
APIs. Active hidden references travel to the configured model judges and may
be stored in the private BridgeBench API. Withholding them reduces
contamination risk; it does not prove non-retention or prevent all leakage.
See [Private packs](private-packs.md) for the complete trust boundary and
incident procedure.

## Reviewer completion checklist

A review is complete when you can answer:

- What does each arena measure, and which claims are out of scope?
- Did both competitors receive identical public evidence?
- How were identities hidden and answer order balanced?
- Do the recorded votes support the winner?
- Do the point and Elo transitions replay from the journal?
- Can the task and run inputs be tied to their recorded hashes?
- Which conclusions still depend on hidden references or model-judge quality?
- Does every numbered overall entry have observed evidence from all seven
  judged arenas, with no neutral value substituted for missing coverage?

If a published result does not reproduce, use the
[ladder audit report](https://github.com/bridge-mind/bridgebench/issues/new?template=audit-report.yml)
and include the journal source, first failing line, verifier output, and exact
reproduction command. Never include credentials, active hidden references, or
private filesystem paths.
