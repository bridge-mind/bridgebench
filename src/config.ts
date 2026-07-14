/**
 * Engine-wide configuration: paths, the active season, and the pinned
 * rendering stack. Everything that defines "what a season is" lives here
 * so a season rollover is a single, reviewable diff.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TASKS_DIR = path.join(REPO_ROOT, 'tasks', 'current');
export const RESULTS_DIR = path.join(REPO_ROOT, 'results');
export const SNAPSHOTS_DIR = path.join(REPO_ROOT, 'snapshots');
export const VENDOR_DIR = path.join(REPO_ROOT, 'vendor');

/**
 * Private overlay root (hidden probes live here during an active season).
 * Points at a checkout of the private bridgebench-private repo.
 */
export function privateDir(): string | null {
  return process.env.BRIDGEBENCH_PRIVATE_DIR ?? null;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Stamped on snapshots and registry exports. Keep in sync with package.json. */
export const ENGINE_VERSION = '3.0.0-alpha.0';

// ---------------------------------------------------------------------------
// Season
// ---------------------------------------------------------------------------

export interface SeasonConfig {
  /** Season number, monotonically increasing. */
  id: number;
  /** Human name shown on leaderboards. */
  name: string;
  /** Task ID prefix, e.g. "s1-". */
  taskPrefix: string;
  startsAt: string;
  endsAt: string;
}

export const SEASON: SeasonConfig = {
  id: 1,
  name: 'Season 1',
  taskPrefix: 's1-',
  startsAt: '2026-07-06',
  endsAt: '2026-10-04',
};

// ---------------------------------------------------------------------------
// Pinned rendering stack (changing any of these mid-season breaks
// comparability — bump only at a season rollover)
// ---------------------------------------------------------------------------

export const THREE_VERSION = '0.182.0';

export const THREE_VENDOR_WEB_ROOT = `/vendor/three@${THREE_VERSION}`;

export const THREE_VENDOR_LOCAL_DIR = path.join(VENDOR_DIR, `three@${THREE_VERSION}`);

/** The one true import map. The normalizer rewrites artifacts to exactly this. */
export const CANONICAL_IMPORT_MAP = {
  imports: {
    three: `${THREE_VENDOR_WEB_ROOT}/three.module.min.js`,
    'three/addons/': `${THREE_VENDOR_WEB_ROOT}/addons/`,
  },
} as const;

export const CANONICAL_IMPORT_MAP_JSON = JSON.stringify(CANONICAL_IMPORT_MAP);

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

// Environment loading is handled once for the whole CLI by
// `loadProjectEnv()` in `../env.js` (called from `runCli()`); the UI suite
// doesn't need its own loader.
