import { z } from 'zod';

import { redactSecrets } from './logger.js';
import { ArenaStore, categoryStoreConfig } from './store.js';
import { TaskLoader } from './tasks.js';
import type { BenchmarkCategory, CompleteArenaTask, MatchResult } from './types.js';

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

const ADMIN_KEY_HEADER = 'x-bridgebench-admin-key';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiConfig {
  baseUrl: string;
  adminKey: string;
  timeoutMs: number;
}

/**
 * Reads an explicit API target from the environment. Publishing never guesses
 * between a local and production destination.
 */
export function resolveApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const configuredUrl = environment.BRIDGEBENCH_API_URL?.trim();
  if (!configuredUrl) {
    throw new Error('Set BRIDGEBENCH_API_URL to the exact API target before publishing.');
  }
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error('BRIDGEBENCH_API_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('BRIDGEBENCH_API_URL must be an HTTP(S) URL without embedded credentials.');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('BRIDGEBENCH_API_URL must use HTTPS unless it targets localhost.');
  }
  const baseUrl = configuredUrl.replace(/\/+$/, '');
  const adminKey = environment.BRIDGEBENCH_ADMIN_KEY?.trim() ?? '';
  if (!adminKey) {
    throw new Error('Set BRIDGEBENCH_ADMIN_KEY before publishing.');
  }
  return { baseUrl, adminKey, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export function publishTarget(config: ApiConfig): string {
  return new URL(config.baseUrl).origin;
}

async function postJson<T>(
  config: ApiConfig,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [ADMIN_KEY_HEADER]: config.adminKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} → ${response.status}: ${redactSecrets(text).slice(0, 500)}`);
  }
  let decoded: unknown;
  try {
    decoded = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`POST ${path} returned invalid JSON`);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`POST ${path} returned an invalid response contract`);
  }
  return parsed.data;
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
  schema: z.ZodType<R>,
): Promise<R[]> {
  const results: R[] = [];
  let first = true;
  for (const batch of batches) {
    if (!first) await delay(REQUEST_SPACING_MS);
    first = false;
    results.push(await postJson(config, path, wrap(batch), schema));
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
    z.object({ imported: z.number().int().nonnegative() }),
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
