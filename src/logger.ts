import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const KEY_PATTERNS: Array<[RegExp, string]> = [
  [/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]'],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]'],
];

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of KEY_PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

/** Structured logger every arena boundary reports into; one JSONL file per process. */
export interface ArenaLogger {
  readonly filePath: string | null;
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export const noopLogger: ArenaLogger = {
  filePath: null,
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const MAX_DATA_CHARS = 16_000;

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  // Redaction happens on serialized text so nested strings are covered too.
  // The replacement tokens contain no quotes, so the JSON stays parseable.
  let serialized = redactSecrets(JSON.stringify(data));
  if (serialized.length > MAX_DATA_CHARS) {
    serialized = JSON.stringify({ truncated: true, preview: serialized.slice(0, MAX_DATA_CHARS) });
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

export class FileArenaLogger implements ArenaLogger {
  readonly filePath: string;
  private readonly verbose: boolean;

  constructor(options: { dir: string; verbose?: boolean; name?: string }) {
    mkdirSync(options.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(options.dir, `${options.name ?? 'arena'}-${stamp}.log.jsonl`);
    this.verbose = options.verbose ?? false;
  }

  debug(event: string, data: Record<string, unknown> = {}): void {
    this.write('debug', event, data);
  }

  info(event: string, data: Record<string, unknown> = {}): void {
    this.write('info', event, data);
  }

  warn(event: string, data: Record<string, unknown> = {}): void {
    this.write('warn', event, data);
  }

  error(event: string, data: Record<string, unknown> = {}): void {
    this.write('error', event, data);
  }

  private write(level: LogLevel, event: string, data: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, event, ...sanitizeData(data) };
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (level === 'warn' || level === 'error') {
      console.error(formatConsoleLine(entry));
    } else if (this.verbose) {
      console.log(formatConsoleLine(entry));
    }
  }
}

function formatConsoleLine(entry: { level: LogLevel; event: string } & Record<string, unknown>): string {
  const { ts, level, event, ...rest } = entry;
  const detail = JSON.stringify(rest);
  const suffix = detail === '{}' ? '' : ` ${detail.length > 400 ? `${detail.slice(0, 400)}…` : detail}`;
  return `[bridgebench ${String(ts).slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${event}${suffix}`;
}
