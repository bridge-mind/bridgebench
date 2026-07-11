import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { findProjectRoot } from './paths.js';

const PRIVATE_FIELDS = new Set([
  'expectedResolution',
  'requiredEvidence',
  'disqualifyingErrors',
  'rubric',
]);

function yamlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const target = path.join(root, entry);
    if (statSync(target).isDirectory()) {
      files.push(...yamlFiles(target));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      files.push(target);
    }
  }
  return files;
}

export function checkTaskContamination(
  tasksRoot = path.join(findProjectRoot(import.meta.url), 'tasks'),
): void {
  const failures: string[] = [];
  for (const file of yamlFiles(tasksRoot)) {
    const relative = path.relative(tasksRoot, file);
    if (relative.split(path.sep).includes('private')) {
      failures.push(`${relative}: private task half is present`);
      continue;
    }
    let decoded: unknown;
    try {
      decoded = YAML.parse(readFileSync(file, 'utf8'));
    } catch {
      failures.push(`${relative}: YAML could not be parsed`);
      continue;
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      failures.push(`${relative}: expected a top-level mapping`);
      continue;
    }
    const leaked = Object.keys(decoded).filter((key) => PRIVATE_FIELDS.has(key));
    if (leaked.length > 0) {
      failures.push(`${relative}: private fields ${leaked.join(', ')}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Task contamination check failed:\n${failures.join('\n')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    checkTaskContamination();
    console.log('✓ public task files contain no private-only fields');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
