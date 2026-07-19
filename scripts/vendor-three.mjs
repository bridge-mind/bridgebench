#!/usr/bin/env node
/**
 * Vendor the pinned three.js build into vendor/three@<version>/.
 *
 * The vendored directory is COMMITTED so clones are hermetic without npm and
 * so bridgebench-ui can serve byte-identical files from public/vendor/.
 *
 * Layout produced:
 *   vendor/three@<version>/three.module.min.js   (imports ./three.core.min.js)
 *   vendor/three@<version>/three.core.min.js
 *   vendor/three@<version>/addons/<subset of examples/jsm>/
 *
 * The addons subset is curated: directories that work fully offline (no
 * FileLoader/fetch dependencies at import time). Loaders, libs, nodes/tsl,
 * webxr and renderers are deliberately excluded — artifact CSP has
 * connect-src 'none', so anything that fetches at runtime would break anyway.
 */

import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const threePkg = JSON.parse(
  readFileSync(join(repoRoot, 'node_modules/three/package.json'), 'utf8'),
);
const version = threePkg.version;

const srcBuild = join(repoRoot, 'node_modules/three/build');
const srcJsm = join(repoRoot, 'node_modules/three/examples/jsm');
const dest = join(repoRoot, `vendor/three@${version}`);

const ADDON_DIRS = [
  'controls',
  'postprocessing',
  'shaders',
  'math',
  'geometries',
  'utils',
  'objects',
  'lines',
  'effects',
  'modifiers',
  'curves',
  'helpers',
  'materials',
  'misc',
];

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(dest, 'addons'), { recursive: true });

for (const file of ['three.module.min.js', 'three.core.min.js']) {
  cpSync(join(srcBuild, file), join(dest, file));
}

for (const dir of ADDON_DIRS) {
  cpSync(join(srcJsm, dir), join(dest, 'addons', dir), { recursive: true });
}

// Sanity pass: remove vendored addon files whose imports cannot resolve in
// the vendored tree (excluded dirs, three/tsl, three/webgpu, npm packages).
// Removing them means a model import fails loudly at validation time rather
// than silently 404ing in the browser. Runs to a fixed point so removals
// cascade to dependents.
const removed = [];

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listJsFiles(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function importSpecifiers(source) {
  return [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

let changed = true;
while (changed) {
  changed = false;
  for (const full of listJsFiles(join(dest, 'addons'))) {
    const specs = importSpecifiers(readFileSync(full, 'utf8'));
    const bad = specs.some((spec) => {
      if (spec === 'three') return false;
      if (spec.startsWith('three/addons/')) {
        try {
          statSync(join(dest, 'addons', spec.slice('three/addons/'.length)));
          return false;
        } catch {
          return true;
        }
      }
      if (spec.startsWith('.')) {
        try {
          statSync(resolve(dirname(full), spec));
          return false;
        } catch {
          return true;
        }
      }
      return true; // three/tsl, three/webgpu, npm packages — not vendored
    });
    if (bad) {
      rmSync(full);
      removed.push(full.slice(dest.length + 1));
      changed = true;
    }
  }
}

// Manifest for the validator + sync script.
const manifest = {
  library: 'three',
  version,
  files: ['three.module.min.js', 'three.core.min.js'],
  addonDirs: ADDON_DIRS,
  removedIncompatible: removed,
  importMap: {
    imports: {
      three: `/vendor/three@${version}/three.module.min.js`,
      'three/addons/': `/vendor/three@${version}/addons/`,
    },
  },
};
writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Vendored three@${version} → ${dest}`);
console.log(`Removed ${removed.length} addon files with unresolvable imports:`);
for (const r of removed) console.log(`  - ${r}`);
