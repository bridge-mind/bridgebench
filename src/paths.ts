import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the bridgebench package's own root — the nearest ancestor
 * directory holding a package.json — from a module URL. Unlike
 * findProjectRoot it does not key on the package name, so it resolves
 * correctly both in a repo checkout and installed under node_modules,
 * and survives a scoped rename. Use it for assets that ship with the
 * package (tasks/, package.json); never for write targets.
 */
export function packageRoot(fromUrl: string): string {
  let current = path.dirname(fileURLToPath(fromUrl));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  throw new Error('Unable to locate the bridgebench package root');
}

export function findProjectRoot(fromUrl: string): string {
  let current = path.dirname(fileURLToPath(fromUrl));
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
        if (parsed.name === 'bridgebench') return current;
      } catch {
        // Keep walking. A malformed unrelated manifest is not our project root.
      }
    }
    current = path.dirname(current);
  }
  throw new Error('Unable to locate BridgeBench V3 project root');
}
