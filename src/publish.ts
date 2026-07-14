import { z } from 'zod';

import { chunk, postChunks, resolveApiConfig, type ApiConfig } from './api-client.js';
import { ArenaStore, categoryStoreConfig } from './store.js';
import { TaskLoader } from './tasks.js';
import type { BenchmarkCategory, CompleteArenaTask, MatchResult } from './types.js';

export { publishTarget, resolveApiConfig, type ApiConfig } from './api-client.js';

/**
 * Publish glue: pushes the engine's authored task pack and its match journal
 * to the bridgebench.ai API. The local verified journal is the execution
 * authority; the API is a one-way published replica and public read surface.
 *
 * Both API endpoints are admin-key guarded and idempotent (upsert on task
 * key+version, insert-or-skip on match key), so re-publishing is always safe.
 * Publishing tasks requires the private overlay (the API stores both halves;
 * hidden references live in a table no public endpoint reads) — see
 * docs/private-packs.md.
 */

/**
 * Load, validate, and push a category's task pack. The API import contract
 * requires both halves, so this fails closed (with a pointer to
 * docs/private-packs.md) when the private overlay is absent.
 */
export async function publishTasks(
  category: BenchmarkCategory,
  config: ApiConfig = resolveApiConfig(),
): Promise<{ imported: number }> {
  // Speed is a public-only pack (no hidden reference / rubric), so it is
  // imported without a private overlay. Every other arena is judged and its
  // import contract requires both halves — fail closed when the overlay is
  // absent (with a pointer to docs/private-packs.md).
  const requirePrivate = category !== 'speed';
  const loaded = (await new TaskLoader(category).loadAll(
    requirePrivate ? { requirePrivate: true } : {},
  )) as CompleteArenaTask[];
  // Batch a few tasks per request (each task's inline artifacts can be ~100KB)
  // to stay under both the body limit and the operator throttle.
  const results = await postChunks<CompleteArenaTask, { imported: number }>(
    config,
    '/arena/tasks/import',
    chunk(loaded, 4),
    (batch) => ({ tasks: batch }),
    z.object({ imported: z.number().int().nonnegative() }),
  );
  const imported = results.reduce((sum, r) => sum + (r.imported ?? 0), 0);
  return { imported };
}

/** Push a match journal from the given store (idempotent on the engine match key). */
export async function publishJournalFromStore(
  store: ArenaStore,
  config: ApiConfig = resolveApiConfig(),
): Promise<{ imported: number; skipped: number; matches: number }> {
  const journal: MatchResult[] = store.readAll();
  if (journal.length === 0) {
    return { imported: 0, skipped: 0, matches: 0 };
  }
  const results = await postChunks<MatchResult, { imported: number; skipped: number }>(
    config,
    '/arena/matches/import',
    chunk(journal, 20),
    (batch) => ({
      matches: batch,
    }),
    z.object({
      imported: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  );
  const imported = results.reduce((sum, r) => sum + (r.imported ?? 0), 0);
  const skipped = results.reduce((sum, r) => sum + (r.skipped ?? 0), 0);
  return { imported, skipped, matches: journal.length };
}

/** Push a category's local match journal (idempotent on the engine match key). */
export async function publishJournal(
  category: BenchmarkCategory,
  config: ApiConfig = resolveApiConfig(),
): Promise<{ imported: number; skipped: number; matches: number }> {
  return publishJournalFromStore(new ArenaStore(categoryStoreConfig(category)), config);
}

export { postJson } from './api-client.js';
