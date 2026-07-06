#!/usr/bin/env node
/**
 * Register the season's qualified artifacts with the voting API
 * (bridgebench-api POST /ui-bench/artifacts/import).
 *
 * Reads results/ui/snapshot.json, converts each result into an import row
 * (artifact/screenshot web URLs use the same slug convention as
 * sync-to-ui.mjs), and POSTs one chunk PER TASK — the API caps request
 * bodies at 16kb.
 *
 *   BRIDGEBENCH_API_URL   default https://api.bridgebench.ai
 *   UI_BENCH_ADMIN_KEY    required (same value the API deployment holds)
 *
 * Run AFTER sync-to-ui has copied the artifacts into bridgebench-ui and the
 * site has deployed — the API stores site-relative URLs, not files.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(repoRoot, 'results', 'ui', 'snapshot.json');

const apiUrl = (process.env.BRIDGEBENCH_API_URL ?? 'https://api.bridgebench.ai').replace(/\/$/, '');
const adminKey = process.env.UI_BENCH_ADMIN_KEY;

if (!adminKey) {
  console.error('UI_BENCH_ADMIN_KEY is required (matches the API deployment env).');
  process.exit(1);
}
if (!existsSync(snapshotPath)) {
  console.error(`No snapshot at ${snapshotPath} — run \`npm run ui -- run …\` first.`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const season = snapshot.season?.id;
if (!season) {
  console.error('Snapshot has no season stamp.');
  process.exit(1);
}

function slug(modelId) {
  return modelId.replace(/\//g, '--').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
}

// Group import rows per task so each request stays well under the body cap.
const byTask = new Map();
for (const [modelId, entry] of Object.entries(snapshot.models ?? {})) {
  for (const result of entry.results ?? []) {
    if (!result.artifactPaths?.html) continue;
    const modelSlug = slug(modelId);
    const diagnostics = result.qualification?.diagnostics ?? {};
    const row = {
      taskId: result.taskId,
      modelId,
      displayName: result.displayName,
      artifactUrl: `/ui-bench-artifacts/${result.taskId}/${modelSlug}.html`,
      screenshotUrl: `/ui-bench-artifacts/${result.taskId}/${modelSlug}.png`,
      ...(result.artifactSha256 ? { sha256: result.artifactSha256 } : {}),
      qualified: Boolean(result.qualification?.qualified),
      badges: {
        webgl: diagnostics.webglActive ?? null,
        fps: diagnostics.fps ?? null,
        animated: diagnostics.animationDetected ?? false,
        controls: `${diagnostics.controlsFound ?? 0}/${diagnostics.controlsDeclared ?? 0}`,
        determinism: diagnostics.determinismOk ?? null,
        probes:
          diagnostics.probesTotal != null
            ? `${diagnostics.probesPassed}/${diagnostics.probesTotal}`
            : null,
      },
    };
    const rows = byTask.get(result.taskId) ?? [];
    rows.push(row);
    byTask.set(result.taskId, rows);
  }
}

let imported = 0;
for (const [taskId, artifacts] of byTask) {
  const res = await fetch(`${apiUrl}/ui-bench/artifacts/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bridgebench-admin-key': adminKey,
    },
    body: JSON.stringify({ season, artifacts }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✗ ${taskId}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }
  imported += body.imported ?? 0;
  console.log(`✓ ${taskId}: ${body.imported} artifacts`);
}

console.log(`Done — ${imported} artifacts registered for season ${season} at ${apiUrl}.`);
