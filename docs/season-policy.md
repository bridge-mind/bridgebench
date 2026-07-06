# Season policy — the 90-day rotation

Static benchmarks decay: tasks leak into training data, scores inflate, and
the leaderboard starts measuring memorization. BridgeBench is built around
that reality.

## The rules

1. **A season lasts ~90 days.** Season 1: 2026-07-06 → 2026-10-04
   (`src/config.ts` is the single source of truth).
2. **Task IDs are season-prefixed** (`s1-…`), so artifact URLs and results
   never collide across seasons.
3. **Public vs hidden split.** Task prompts, declared controls, and scoring
   methodology are public from day one (this repo). The interaction probes
   that decide the interaction dimension live in the private
   `bridgebench-private` repo while the season is live.
4. **Retirement = full publication.** When a season ends, its probe files are
   copied into `tasks/retired/season-<n>/ui/` in this repo. Anyone can then
   re-run and audit exactly what was measured. If a retired score doesn't
   reproduce, open an issue.
5. **Scores are season-stamped and never mixed.** The aggregator drops
   results whose `season` differs from the active one; snapshots carry the
   season block and engine pins (three.js version, weights).
6. **Methodology persists, tasks rotate.** Scoring dimensions and weights
   stay stable across seasons so a model's trajectory is comparable even as
   the tasks underneath it change. Changing a weight or a pin mid-season is
   forbidden — it invalidates every comparison in that season.
7. **Public runs are first-class.** Without `BRIDGEBENCH_PRIVATE_DIR`, the
   engine still runs everything; interaction scores fall back to
   declared-control presence and are flagged `partial` in results and on the
   leaderboard.

## Season rollover checklist

1. Author next season's tasks (`tasks/current/ui/s<n+1>-*.yaml`) and probes
   (in bridgebench-private).
2. Bump `SEASON` in `src/config.ts`; optionally bump the three.js pin
   (`npm run vendor:three`, commit the new `vendor/three@<ver>/`).
3. Move retiring probe files → `tasks/retired/season-<n>/ui/`.
4. Archive the season's snapshot under `snapshots/season-<n>/`.
5. Move retired artifacts out of bridgebench-ui `public/` into a GitHub
   Release archive.
