#!/usr/bin/env node

import { runCli } from './commands.js';
import { sanitizeError } from './openrouter.js';

runCli().catch((error) => {
  console.error(`BridgeBench: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
