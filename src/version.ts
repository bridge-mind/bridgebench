import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { findProjectRoot } from './paths.js';

const PackageMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

const metadata = PackageMetadataSchema.parse(
  JSON.parse(readFileSync(path.join(findProjectRoot(import.meta.url), 'package.json'), 'utf8')),
);

export const PACKAGE_NAME = metadata.name;
export const ENGINE_VERSION = metadata.version;
