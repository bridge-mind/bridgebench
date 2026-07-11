import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
