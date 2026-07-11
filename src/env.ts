import { existsSync } from 'node:fs';
import path from 'node:path';

import { findProjectRoot } from './paths.js';

export const ENV_PATH = path.join(findProjectRoot(import.meta.url), '.env');

export type ProjectEnvLoadResult =
  { status: 'missing' } | { status: 'loaded' } | { status: 'error'; reason: string };

/**
 * Loads the project-root .env into process.env regardless of the process cwd
 * or launch flags. Variables already present in the environment win, matching
 * node's --env-file precedence. Safe to call repeatedly: a key added to .env
 * after startup is picked up on the next call.
 */
export function loadProjectEnv(): ProjectEnvLoadResult {
  if (!existsSync(ENV_PATH)) return { status: 'missing' };
  try {
    process.loadEnvFile(ENV_PATH);
    return { status: 'loaded' };
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
