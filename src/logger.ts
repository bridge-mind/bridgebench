/**
 * Run-scoped debug logger — the flight recorder for a benchmark run.
 *
 * Every stage of a run (provider request/stream/response, extraction,
 * normalization, validation, browser evaluation, qualification) emits
 * structured events here so a failed task can be diagnosed from the log
 * alone, without re-running the model.
 *
 * Two sinks per run, both under results/ui/logs/<run-id>/:
 *   run.jsonl   full-fidelity structured events (one JSON object per line)
 *   run.log     human-readable mirror (long strings truncated for scanning)
 *
 * The logger is a process-wide singleton so deep modules (providers,
 * evaluator) can emit events without threading a logger through every
 * constructor. Until `initRunLogger()` is called it is a no-op, which keeps
 * tests and non-run CLI commands silent.
 *
 * Env knobs:
 *   BRIDGEBENCH_LOG_LEVEL   minimum level written to file  (default: debug)
 *   BRIDGEBENCH_LOG_ECHO    minimum level echoed to stderr  (default: warn)
 *
 * API keys never flow through this module by design (request bodies carry no
 * credentials), and `redact()` scrubs anything key-shaped as a safety net.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Field names whose values are always replaced, wherever they appear. */
const REDACTED_KEY_RE = /(api[-_]?key|authorization|secret|password|bearer)/i;

/** Max string length mirrored into the human-readable run.log. */
const TEXT_SINK_MAX_STRING = 400;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEY_RE.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

/** JSON.stringify that survives circular refs and BigInt. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[circular]';
      seen.add(val);
    }
    return val;
  });
}

function truncateForText(value: unknown): unknown {
  if (typeof value === 'string' && value.length > TEXT_SINK_MAX_STRING) {
    return `${value.slice(0, TEXT_SINK_MAX_STRING)}… [${value.length} chars total — full value in run.jsonl]`;
  }
  if (Array.isArray(value)) return value.map(truncateForText);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = truncateForText(val);
    }
    return out;
  }
  return value;
}

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  return raw && raw in LEVEL_RANK ? (raw as LogLevel) : fallback;
}

export interface RunLoggerConfig {
  /** Directory the log files are written into (created if missing). */
  dir: string;
  /** Minimum level written to file. Default: debug (everything). */
  level?: LogLevel;
  /** Minimum level echoed to stderr. Default: warn. */
  echoLevel?: LogLevel;
}

interface LoggerCore {
  dir: string;
  level: LogLevel;
  echoLevel: LogLevel;
  jsonl: WriteStream | null;
  text: WriteStream | null;
}

export class RunLogger {
  private constructor(
    private readonly core: LoggerCore | null,
    private readonly context: Record<string, unknown>,
  ) {}

  static noop(): RunLogger {
    return new RunLogger(null, {});
  }

  static open(config: RunLoggerConfig): RunLogger {
    mkdirSync(config.dir, { recursive: true });
    const core: LoggerCore = {
      dir: config.dir,
      level: config.level ?? parseLevel(process.env.BRIDGEBENCH_LOG_LEVEL, 'debug'),
      echoLevel:
        config.echoLevel ?? parseLevel(process.env.BRIDGEBENCH_LOG_ECHO, 'warn'),
      jsonl: createWriteStream(path.join(config.dir, 'run.jsonl'), { flags: 'a' }),
      text: createWriteStream(path.join(config.dir, 'run.log'), { flags: 'a' }),
    };
    return new RunLogger(core, {});
  }

  get dir(): string | null {
    return this.core?.dir ?? null;
  }

  /** A logger sharing this one's sinks with extra context on every event. */
  child(context: Record<string, unknown>): RunLogger {
    return new RunLogger(this.core, { ...this.context, ...context });
  }

  event(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (!this.core) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...this.context,
      ...(data ? (redact(data) as Record<string, unknown>) : {}),
    };

    if (LEVEL_RANK[level] >= LEVEL_RANK[this.core.level] && this.core.jsonl) {
      this.core.jsonl.write(`${safeStringify(entry)}\n`);
      if (this.core.text) {
        const { ts, level: lvl, event: name, ...rest } = entry;
        const detail = Object.keys(rest).length
          ? ` ${inspect(truncateForText(rest), { depth: 6, breakLength: 200, compact: true })}`
          : '';
        this.core.text.write(`${ts} [${lvl.toUpperCase().padEnd(5)}] ${name}${detail}\n`);
      }
    }

    if (LEVEL_RANK[level] >= LEVEL_RANK[this.core.echoLevel]) {
      process.stderr.write(
        `[bridgebench:${level}] ${event} ${inspect(truncateForText({ ...this.context, ...(data ?? {}) }), { depth: 4, breakLength: 160, compact: true })}\n`,
      );
    }
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.event('debug', event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.event('info', event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.event('warn', event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.event('error', event, data);
  }

  async close(): Promise<void> {
    if (!this.core) return;
    const { jsonl, text } = this.core;
    this.core.jsonl = null;
    this.core.text = null;
    await Promise.all(
      [jsonl, text].map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (!stream) return resolve();
            stream.end(() => resolve());
          }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let active: RunLogger = RunLogger.noop();

/** Open the run logger. Subsequent `getRunLogger()` calls anywhere return it. */
export function initRunLogger(config: RunLoggerConfig): RunLogger {
  active = RunLogger.open(config);
  return active;
}

/** The active run logger, or a no-op when no run is in progress. */
export function getRunLogger(): RunLogger {
  return active;
}

/** Flush and detach the active run logger. */
export async function closeRunLogger(): Promise<void> {
  const current = active;
  active = RunLogger.noop();
  await current.close();
}
