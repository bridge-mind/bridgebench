import { defineConfig } from 'tsup';

/**
 * Dual-format build for the published package. ESM is the native format;
 * CJS artifacts exist so CommonJS consumers (bridgebench-api's NestJS build,
 * Jest) can require() the package. `shims` rewrites import.meta.url in the
 * CJS output so packageRoot() keeps resolving the installed package.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'contracts/index': 'src/contracts/index.ts',
    tasks: 'src/tasks.ts',
    client: 'src/client.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // No sourcemaps in the published artifact: they embed absolute build-host
  // paths, and the full source is public on GitHub anyway.
  sourcemap: false,
  splitting: true,
  clean: true,
  target: 'node20',
  shims: true,
  outDir: 'dist',
});
