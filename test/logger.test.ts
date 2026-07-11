import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileArenaLogger, redactSecrets } from '../src/logger.js';

describe('run logger', () => {
  it('writes structured JSONL entries with level and event', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bridgebench-log-'));
    const logger = new FileArenaLogger({ dir });
    logger.debug('openrouter.request', { model: 'openai/gpt-5.6-sol', attempt: 1 });
    logger.info('openrouter.completed', { latencyMs: 1234 });
    const lines = readFileSync(logger.filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'debug', event: 'openrouter.request', model: 'openai/gpt-5.6-sol', attempt: 1 });
    expect(lines[1]).toMatchObject({ level: 'info', event: 'openrouter.completed', latencyMs: 1234 });
    expect(typeof lines[0]!.ts).toBe('string');
  });

  it('redacts credentials from nested log data', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bridgebench-log-'));
    const logger = new FileArenaLogger({ dir });
    logger.info('test', { nested: { error: 'Bearer sk-or-v1-supersecretvalue rejected' } });
    const raw = readFileSync(logger.filePath, 'utf8');
    expect(raw).not.toContain('supersecretvalue');
    expect(raw).toContain('[REDACTED');
  });

  it('redactSecrets strips OpenRouter keys and bearer tokens', () => {
    expect(redactSecrets('key sk-or-v1-abc123 leaked')).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOi.payload')).not.toContain('eyJhbGciOi');
  });

  it('truncates oversized payloads instead of writing unbounded lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bridgebench-log-'));
    const logger = new FileArenaLogger({ dir });
    logger.info('big', { blob: 'x'.repeat(100_000) });
    const line = readFileSync(logger.filePath, 'utf8').trim();
    expect(line.length).toBeLessThan(40_000);
    expect(JSON.parse(line)).toMatchObject({ truncated: true });
  });
});
