import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { CATEGORIES } from '../src/contracts/categories.js';
import { TASKS_PER_CATEGORY } from '../src/tasks.js';

/**
 * Packaging smoke test: packs the tarball exactly as `npm publish` would,
 * asserts its contents (no raw src, no compiled tests, no private task
 * halves, both public packs present), installs it into a throwaway ESM
 * consumer, and imports every published entry point.
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PackReportSchema = z
  .object({
    filename: z.string().min(1),
    files: z.array(z.object({ path: z.string().min(1) })),
  })
  .array()
  .length(1);

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function assertContents(paths: readonly string[]): void {
  const failures: string[] = [];
  const required = [
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/index.d.cts',
    'dist/contracts/index.js',
    'dist/contracts/index.cjs',
    'dist/tasks.js',
    'dist/tasks.cjs',
    'dist/client.js',
    'dist/client.cjs',
    'dist/cli.js',
    'docs/README.md',
    'docs/operator-guide.md',
    'docs/reviewing-bridgebench.md',
    'package.json',
    'README.md',
    'LICENSE',
  ];
  for (const file of required) {
    if (!paths.includes(file)) failures.push(`missing ${file}`);
  }
  for (const file of paths) {
    if (file === 'src' || file.startsWith('src/')) failures.push(`raw source shipped: ${file}`);
    if (file.startsWith('dist/test/')) failures.push(`compiled test shipped: ${file}`);
    if (file.startsWith('tasks/') && file.split('/').includes('private')) {
      failures.push(`PRIVATE TASK HALF SHIPPED: ${file}`);
    }
  }
  for (const category of CATEGORIES) {
    const pack = paths.filter(
      (file) => file.startsWith(`tasks/${category}/public/`) && file.endsWith('.yaml'),
    );
    if (pack.length !== TASKS_PER_CATEGORY) {
      failures.push(
        `expected ${TASKS_PER_CATEGORY} ${category} public tasks in the tarball, found ${pack.length}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Tarball contents check failed:\n${failures.join('\n')}`);
  }
}

const CONSUMER_SMOKE = `
import assert from 'node:assert/strict';

import { ArenaRunner, MockOpenRouterGateway, applyEloWin, scheduleMatches, verifyJournal, ENGINE_VERSION, TASKS_PER_CATEGORY } from 'bridgebench';
import { CATEGORIES, CONTRACTS_VERSION, TaskPublicSchema } from 'bridgebench/contracts';
import { TaskLoader, mergePrivateHalves } from 'bridgebench/tasks';
import { resolveApiConfig, publishTarget } from 'bridgebench/client';

assert.equal(typeof ArenaRunner, 'function');
assert.equal(typeof MockOpenRouterGateway, 'function');
assert.equal(typeof applyEloWin, 'function');
assert.equal(typeof scheduleMatches, 'function');
assert.equal(typeof verifyJournal, 'function');
assert.equal(typeof resolveApiConfig, 'function');
assert.equal(typeof publishTarget, 'function');
assert.equal(typeof TaskPublicSchema.parse, 'function');
assert.match(ENGINE_VERSION, /^\\d+\\.\\d+\\.\\d+/);
assert.match(CONTRACTS_VERSION, /^\\d+\\.\\d+\\.\\d+$/);

for (const category of CATEGORIES) {
  const tasks = await new TaskLoader(category).loadAll();
  assert.equal(tasks.length, TASKS_PER_CATEGORY, category + ' pack must load the full public task set');
  assert.ok(tasks.every((task) => task.private === null), category + ' pack must ship public halves only');
}

const [first] = await new TaskLoader('reasoning').loadAll();
const merged = mergePrivateHalves([first], [
  {
    value: {
      id: first.public.id,
      version: first.public.version,
      expectedResolution: 'stand-in reference used by the packaging smoke test',
      requiredEvidence: [first.public.artifacts[0].id],
      disqualifyingErrors: [],
      rubric: {
        correctness: 'stand-in',
        evidenceGrounding: 'stand-in',
        constraintHandling: 'stand-in',
        completeness: 'stand-in',
      },
    },
    hash: 'a'.repeat(64),
  },
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].privateHash, 'a'.repeat(64));
assert.notEqual(merged[0].private, null);

console.log('pack smoke: all entry points import and both public packs load');
`;

const CONSUMER_SMOKE_CJS = `
const assert = require('node:assert/strict');

const { ArenaRunner, applyEloWin, canonicalJson, TaskLoader, ENGINE_VERSION, TASKS_PER_CATEGORY } = require('bridgebench');
const { CATEGORIES, CONTRACTS_VERSION } = require('bridgebench/contracts');
const { mergePrivateHalves } = require('bridgebench/tasks');
const { resolveApiConfig } = require('bridgebench/client');

assert.equal(typeof ArenaRunner, 'function');
assert.equal(typeof mergePrivateHalves, 'function');
assert.equal(typeof resolveApiConfig, 'function');
assert.match(ENGINE_VERSION, /^\\d+\\.\\d+\\.\\d+/);
assert.match(CONTRACTS_VERSION, /^\\d+\\.\\d+\\.\\d+$/);
assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
const { ratingA } = applyEloWin(1000, 1000, 'a');
assert.equal(ratingA, 1016);

void (async () => {
  for (const category of CATEGORIES) {
    const tasks = await new TaskLoader(category).loadAll();
    assert.equal(tasks.length, TASKS_PER_CATEGORY, category + ' pack must load the full public task set via require()');
  }
  console.log('pack smoke: CJS require() works and both public packs load');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

function main(): void {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'bridgebench-pack-'));
  let failed = false;
  try {
    // Lifecycle-script output (prepack) can precede the JSON report on
    // stdout, so parse from the first line the report starts on.
    const raw = npm(['pack', '--json', '--pack-destination', temp], ROOT);
    const jsonStart = raw.indexOf('[\n');
    if (jsonStart < 0) throw new Error('npm pack emitted no JSON report');
    const report = PackReportSchema.parse(JSON.parse(raw.slice(jsonStart)));
    const packed = report[0];
    if (!packed) throw new Error('npm pack reported no tarball');
    assertContents(packed.files.map((file) => file.path));

    const consumer = path.join(temp, 'consumer');
    mkdirSync(consumer);
    writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    );
    npm(['install', '--no-audit', '--no-fund', path.join(temp, packed.filename)], consumer);
    writeFileSync(path.join(consumer, 'smoke.mjs'), CONSUMER_SMOKE);
    execFileSync('node', ['smoke.mjs'], { cwd: consumer, stdio: 'inherit' });
    writeFileSync(path.join(consumer, 'smoke.cjs'), CONSUMER_SMOKE_CJS);
    execFileSync('node', ['smoke.cjs'], { cwd: consumer, stdio: 'inherit' });
    console.log('✓ packaging smoke test passed');
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Inspect the working directory: ${temp}`);
    process.exitCode = 1;
  } finally {
    if (!failed) rmSync(temp, { recursive: true, force: true });
  }
}

main();
