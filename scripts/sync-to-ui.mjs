#!/usr/bin/env node
/**
 * Sync UI Bench results into the bridgebench-ui site repo:
 *
 *   snapshot   results/ui/snapshot.json → ../bridgebench-ui/src/data/ui-bench-snapshot.json
 *   lite       leaderboard-only JSON    → ../bridgebench-ui/src/data/ui-bench-leaderboard.json
 *   artifacts  normalized.html + shots  → ../bridgebench-ui/public/ui-bench-artifacts/<taskId>/<slug>.{html,png}
 *   vendor     vendor/three@<ver>/      → ../bridgebench-ui/public/vendor/three@<ver>/
 *
 * Idempotent: re-running only rewrites what changed. Snapshot results gain
 * web-relative artifactUrl/screenshotUrl fields (same convention the site's
 * buildArtifactUrl already uses).
 *
 * NOTE: bridgebench-ui main still renders the v2 snapshot shape. Run this
 * against a feature branch of the site until the v3 data layer lands there.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = process.env.BRIDGEBENCH_UI_DIR ?? path.resolve(repoRoot, '..', 'bridgebench-ui');

const snapshotPath = path.join(repoRoot, 'results', 'ui', 'snapshot.json');

if (!existsSync(snapshotPath)) {
  console.error(`No snapshot at ${snapshotPath} — run \`npm run ui -- run …\` first.`);
  process.exit(1);
}
if (!existsSync(uiRoot)) {
  console.error(`bridgebench-ui not found at ${uiRoot} (override with BRIDGEBENCH_UI_DIR).`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

function slug(modelId) {
  return modelId.replace(/\//g, '--').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
}

// ── Artifacts ─────────────────────────────────────────────────────────────
const artifactsOut = path.join(uiRoot, 'public', 'ui-bench-artifacts');
let copiedArtifacts = 0;
let missingArtifacts = 0;

for (const [modelId, entry] of Object.entries(snapshot.models ?? {})) {
  const modelSlug = slug(modelId);
  for (const result of entry.results ?? []) {
    const destDir = path.join(artifactsOut, result.taskId);

    if (result.artifactPaths?.html && existsSync(result.artifactPaths.html)) {
      mkdirSync(destDir, { recursive: true });
      const htmlDest = path.join(destDir, `${modelSlug}.html`);
      cpSync(result.artifactPaths.html, htmlDest);
      result.artifactUrl = `/ui-bench-artifacts/${result.taskId}/${modelSlug}.html`;
      copiedArtifacts++;
    } else if (result.success) {
      missingArtifacts++;
    }

    const shots = result.artifactPaths?.screenshots ?? {};
    for (const [name, shotPath] of Object.entries(shots)) {
      if (!existsSync(shotPath)) continue;
      const suffix = name === 'hero' ? '' : `.${name}`;
      const shotDest = path.join(destDir, `${modelSlug}${suffix}.png`);
      mkdirSync(destDir, { recursive: true });
      cpSync(shotPath, shotDest);
      if (name === 'hero') {
        result.screenshotUrl = `/ui-bench-artifacts/${result.taskId}/${modelSlug}.png`;
      }
    }
  }
}

// ── Vendor (pinned three.js must be byte-identical to the eval copy) ─────
const threeVersion = snapshot.engine?.threeVersion;
if (threeVersion) {
  const vendorSrc = path.join(repoRoot, 'vendor', `three@${threeVersion}`);
  const vendorDest = path.join(uiRoot, 'public', 'vendor', `three@${threeVersion}`);
  if (existsSync(vendorSrc)) {
    cpSync(vendorSrc, vendorDest, { recursive: true });
    console.log(`vendor: three@${threeVersion} → ${path.relative(uiRoot, vendorDest)}`);
  } else {
    console.warn(`vendor: MISSING ${vendorSrc} — run npm run vendor:three`);
  }
}

// ── Snapshot + lite leaderboard ───────────────────────────────────────────
const dataDir = path.join(uiRoot, 'src', 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  path.join(dataDir, 'ui-bench-snapshot.json'),
  JSON.stringify(snapshot, null, 2),
);
writeFileSync(
  path.join(dataDir, 'ui-bench-leaderboard.json'),
  JSON.stringify(
    {
      version: snapshot.version,
      suite: snapshot.suite,
      season: snapshot.season,
      generatedAt: snapshot.generatedAt,
      roster: snapshot.roster,
    },
    null,
    2,
  ),
);

// ── Model registry (canonical model metadata for the site) ───────────────
try {
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const registryJson = execFileSync(
    tsxBin,
    [path.join(repoRoot, 'src', 'cli.ts'), 'models', 'export'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const registry = JSON.parse(registryJson);
  writeFileSync(path.join(dataDir, 'model-registry.json'), registryJson);
  console.log(`registry: ${registry.models.length} models → src/data/model-registry.json`);
} catch (error) {
  console.warn(`registry: export failed — ${error.message ?? error}`);
}

console.log(`snapshot: ${snapshot.roster?.length ?? 0} models → src/data/ui-bench-snapshot.json (+ lite)`);
console.log(`artifacts: ${copiedArtifacts} copied${missingArtifacts ? `, ${missingArtifacts} missing on disk` : ''}`);
console.log('Done. Remember: keep this on a bridgebench-ui feature branch until the v3 data layer lands.');
