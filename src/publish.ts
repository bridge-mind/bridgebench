import { ArenaStore, categoryStoreConfig } from './store.js';
import { TaskLoader } from './tasks.js';
import type { BenchmarkCategory, CompleteArenaTask, MatchResult } from './types.js';

/**
 * Publish glue: pushes the engine's authored task pack and its match journal
 * to the bridgebench.ai API, which is the system of record + public read API
 * for the site. The engine stays the executor; this is the one-way sync of
 * its outputs.
 *
 * Both API endpoints are admin-key guarded and idempotent (upsert on task
 * key+version, insert-or-skip on match key), so re-publishing is always safe.
 * Publishing tasks requires the private overlay (the API stores both halves;
 * hidden references live in a table no public endpoint reads) — see
 * docs/private-packs.md.
 */

const ADMIN_KEY_HEADER = 'x-bridgebench-admin-key';
const DEFAULT_API_URL = 'http://localhost:8083';

interface ApiConfig {
  baseUrl: string;
  adminKey: string;
}

/**
 * Reads the API target from the environment (populated from the project .env by
 * `loadProjectEnv`). Never prints the key. Fails loudly if it is unset.
 */
export function resolveApiConfig(): ApiConfig {
  const baseUrl = (process.env.BRIDGEBENCH_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const adminKey =
    process.env.BRIDGEBENCH_ADMIN_KEY ?? process.env.UI_BENCH_ADMIN_KEY ?? '';
  if (!adminKey) {
    throw new Error(
      'Set BRIDGEBENCH_ADMIN_KEY (or UI_BENCH_ADMIN_KEY) to the API admin key before publishing.',
    );
  }
  return { baseUrl, adminKey };
}

async function postJson(
  config: ApiConfig,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [ADMIN_KEY_HEADER]: config.adminKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} → ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Spacing between admin POSTs to stay under the API's operator throttle. */
const REQUEST_SPACING_MS = 700;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postChunks<T, R extends { imported?: number; skipped?: number }>(
  config: ApiConfig,
  path: string,
  batches: T[][],
  wrap: (batch: T[]) => Record<string, T[]>,
): Promise<R[]> {
  const results: R[] = [];
  let first = true;
  for (const batch of batches) {
    if (!first) await delay(REQUEST_SPACING_MS);
    first = false;
    results.push((await postJson(config, path, wrap(batch))) as R);
  }
  return results;
}

/**
 * Load, validate, and push a category's task pack. The API import contract
 * requires both halves, so this fails closed (with a pointer to
 * docs/private-packs.md) when the private overlay is absent.
 */
export async function publishTasks(
  category: BenchmarkCategory,
  config: ApiConfig = resolveApiConfig(),
): Promise<{ imported: number }> {
  const loaded: CompleteArenaTask[] = await new TaskLoader(category).loadAll({
    requirePrivate: true,
  });
  // Batch a few tasks per request (each task's inline artifacts can be ~100KB)
  // to stay under both the body limit and the operator throttle.
  const results = await postChunks<CompleteArenaTask, { imported: number }>(
    config,
    '/arena/tasks/import',
    chunk(loaded, 4),
    (batch) => ({ tasks: batch }),
  );
  const imported = results.reduce((sum, r) => sum + (r.imported ?? 0), 0);
  return { imported };
}

/** Push a category's match journal (idempotent on the engine match key). */
export async function publishJournal(
  category: BenchmarkCategory,
  config: ApiConfig = resolveApiConfig(),
): Promise<{ imported: number; skipped: number; matches: number }> {
  const store = new ArenaStore(categoryStoreConfig(category));
  const journal: MatchResult[] = store.readAll();
  if (journal.length === 0) {
    return { imported: 0, skipped: 0, matches: 0 };
  }
  // Batch matches so the largest request stays well under the API's limit.
  const results = await postChunks<
    MatchResult,
    { imported: number; skipped: number }
  >(config, '/arena/matches/import', chunk(journal, 20), (batch) => ({
    matches: batch,
  }));
  const imported = results.reduce((sum, r) => sum + (r.imported ?? 0), 0);
  const skipped = results.reduce((sum, r) => sum + (r.skipped ?? 0), 0);
  return { imported, skipped, matches: journal.length };
}
