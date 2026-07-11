# Replay the Elo yourself

A BridgeBench ladder is not a claim — it is the fold of a journal you can re-run. This is the recipe.

## What you need

- The arena's journal: `results/<category>/journal.jsonl`, one JSON object per completed match, in append order. Published season journals are downloadable from [bridgebench.ai](https://bridgebench.ai).
- The matching `runs/` directory for journals that reference versioned run manifests.
- No API key and no private overlay.

Verify the included synthetic journal:

```bash
npm run arena -- verify \
  --category reasoning \
  --journal test/fixtures/journals/valid.jsonl
```

For a downloaded journal, place its run manifests in a sibling `runs/` directory or pass `--manifests-dir <path>`.

## The journal line, abridged

```jsonc
{
  "methodologyVersion": "arena-v0.3.0",
  "runId": "run-…", "matchId": "…", "scheduleIndex": 3, "seed": "…",
  "task": { "id": "…", "version": "2.0.0", "category": "reasoning",
            "cluster": "…", "publicHash": "sha256…", "privateHash": "sha256…" },
  "competitors": { "modelA": "…", "modelB": "…", "responseA": { /* full text + tokens + cost */ }, "responseB": { … } },
  "outcome": "judged",              // judged | forfeit | no-contest
  "winnerModelId": "…",             // null on no-contest
  "panel": { "votes": [ /* 3 votes: verdict, rationale, resolved winner */ ], "agreement": "unanimous" },
  "eloBefore": { "modelA-id": 1000, "modelB-id": 1016 },
  "eloAfter":  { "modelA-id": 1016.4, "modelB-id": 999.6 },
  "pointAwarded": true,
  "matchCostUsd": 0.42
}
```

## Replay algorithm

Elo is classic: initial rating **1000**, **K = 32**, one update per decided match, applied in journal order.

```
expected(a, b) = 1 / (1 + 10^((b − a) / 400))

for each line in journal order:
    if winnerModelId is null: continue          # no-contest — nothing moves
    a, b   = ratings of modelA, modelB          # default 1000 if unseen
    ea     = expected(a, b)
    scoreA = 1 if winnerModelId == modelA else 0
    ratings[modelA] = a + 32 * (scoreA − ea)
    ratings[modelB] = b + 32 * ((1 − scoreA) − (1 − ea))
    points[winnerModelId] += 1
```

Forfeit wins update Elo exactly like judged wins; `no-contest` lines change nothing. Reasoning and hallucination journals fold separately and never share ratings.

The rating formula lives in [`src/elo.ts`](../src/elo.ts). [`src/verification.ts`](../src/verification.ts) owns the validated fold used by reports, resume state, and the CLI verifier.

## Verification is per-line, not just end-state

Every line records `eloBefore` and `eloAfter` for both models. So you don't just check that your final ladder matches the published one — you can assert, at every single match, that:

1. `eloBefore` equals your running ratings at that point;
2. `eloAfter` equals your computed update;
3. the winner is consistent with the panel's votes (two valid votes for the same side), or with a forfeit (exactly one failed response).

`arena verify` rejects a reordered line, edited verdict, inconsistent outcome, wrong point, altered cost, or nudged rating at the first failing line. New journal lines also bind to a versioned run manifest covering the roster, task hashes, prompt policies, methodology, and engine version.

With the repo checked out, `npm run report` verifies the journal before rebuilding `snapshot.json` and `leaderboard.md`; diff them against published snapshots.

## Auditing beyond the math

- **Task drift**: hash the public task file (`sha256` of the raw YAML) and compare with the journaled `publicHash`. For retired packs, do the same with the published private halves against `privateHash` — see [private-packs.md](private-packs.md).
- **Judging**: each vote carries the judge's rationale and resolved winner; `agreement` must match the winner-vote count (three `unanimous`, exactly two `split`).
- **Cost/token accounting**: every response carries its OpenRouter generation ID; `npm run arena -- generation <id>` fetches the provider's own record.

If any of it doesn't reproduce, open an issue with the line number.
