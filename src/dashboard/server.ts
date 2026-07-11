import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import { z } from 'zod';

import { ArenaRunner } from '../arena.js';
import { ENV_PATH, loadProjectEnv } from '../env.js';
import { FileArenaLogger } from '../logger.js';
import { listModels } from '../models.js';
import { OpenRouterClient, sanitizeError } from '../openrouter.js';
import { findProjectRoot } from '../paths.js';
import { buildSnapshot } from '../report.js';
import { ArenaStore, categoryStoreConfig } from '../store.js';
import { TaskLoader } from '../tasks.js';
import {
  BenchmarkCategorySchema,
  CATEGORIES,
  CATEGORY_META,
  type ArenaEvent,
  type ArenaRunConfig,
  type BenchmarkCategory,
} from '../types.js';

loadProjectEnv();

const HOST = '127.0.0.1';
const PORT = 4317;
const ROOT = findProjectRoot(import.meta.url);
const UI_ROOT = path.join(ROOT, 'ui');
const UI_DIST = path.join(ROOT, 'dist-ui');
const MAX_BODY_BYTES = 16_384;

const RunRequestSchema = z.object({
  category: BenchmarkCategorySchema.default('reasoning'),
  seed: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  matches: z.number().int().min(1).max(336),
  maxCostUsd: z.number().finite().min(0.01).max(1_000),
  resume: z.boolean().default(false),
});

type RunStatus = 'idle' | 'running' | 'completed' | 'budget-stopped' | 'failed';

interface DashboardRunState {
  status: RunStatus;
  config: ArenaRunConfig | null;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  completed: number;
  total: number;
  costUsd: number;
  currentMatch: Record<string, unknown> | null;
  error: string | null;
}

const state: DashboardRunState = {
  status: 'idle', config: null, runId: null, startedAt: null, finishedAt: null,
  completed: 0, total: 0, costUsd: 0, currentMatch: null, error: null,
};
const events: ArenaEvent[] = [];
const clients = new Set<ServerResponse>();

function createStore(category: BenchmarkCategory): ArenaStore {
  return new ArenaStore(categoryStoreConfig(category));
}

function setSecurityHeaders(response: ServerResponse, viteDevelopment = false): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Content-Security-Policy',
    viteDevelopment
      ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:4317 ws://localhost:4317 ws://127.0.0.1:24678"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:4317 ws://localhost:4317",
  );
}

function json(response: ServerResponse, status: number, body: unknown): void {
  setSecurityHeaders(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function isAllowedHost(request: IncomingMessage): boolean {
  return request.headers.host === `${HOST}:${PORT}` || request.headers.host === `localhost:${PORT}`;
}

function isAllowedMutation(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const allowedOrigin = origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
  return allowedOrigin && request.headers['content-type']?.startsWith('application/json') === true;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 16 KB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publish(event: ArenaEvent): void {
  // Streaming response deltas are broadcast-only: they update the live view
  // over SSE but never enter the retained history or the run state machine.
  if (event.type === 'competitor.delta') {
    const encoded = `id: ${event.id}\nevent: arena\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(encoded);
    return;
  }
  events.push(event);
  if (events.length > 300) events.splice(0, events.length - 300);
  if (event.type === 'run.started') {
    state.runId = typeof event.data.runId === 'string' ? event.data.runId : null;
  } else if (event.type === 'match.started') {
    state.currentMatch = event.data;
  } else if (event.type === 'match.completed') {
    state.completed = Number(event.data.completed ?? state.completed);
    state.costUsd += Number(event.data.costUsd ?? 0);
  } else if (event.type === 'run.completed') {
    state.status = event.data.stoppedForBudget ? 'budget-stopped' : 'completed';
    state.finishedAt = event.timestamp;
    state.currentMatch = null;
  } else if (event.type === 'run.failed') {
    state.status = 'failed';
    state.finishedAt = event.timestamp;
    state.currentMatch = null;
    state.error = String(event.data.error ?? 'Run failed');
  }
  const encoded = `id: ${event.id}\nevent: arena\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(encoded);
}

async function startRun(config: ArenaRunConfig): Promise<void> {
  state.status = 'running';
  state.config = config;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.completed = 0;
  state.total = config.matches;
  state.costUsd = 0;
  state.currentMatch = null;
  state.error = null;

  try {
    const tasks = await new TaskLoader(config.category).loadAll({ requirePrivate: true });
    const logger = new FileArenaLogger({ dir: path.join(ROOT, 'results', config.category, 'logs'), name: 'dashboard' });
    console.log(`Run log: ${logger.filePath}`);
    const runner = new ArenaRunner(
      new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '', logger),
      createStore(config.category),
      publish,
      logger,
    );
    await runner.run(config, tasks);
  } catch (error) {
    const message = sanitizeError(error);
    publish({
      id: `run-failed-${Date.now()}`,
      type: 'run.failed',
      timestamp: new Date().toISOString(),
      data: { error: message },
    });
  }
}

async function apiHandler(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  if (!url.pathname.startsWith('/api/')) return false;
  if (!isAllowedHost(request)) {
    json(response, 403, { error: 'Untrusted Host header' });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    // A key added to .env after startup should surface without a restart.
    if (!process.env.OPENROUTER_API_KEY) loadProjectEnv();
    // Each category is an independent arena: its own task pack, journal, and
    // Elo ladder. The run state machine stays global because only one run may
    // be active at a time regardless of category.
    const arenas: Record<string, unknown> = {};
    for (const category of CATEGORIES) {
      const tasks = await new TaskLoader(category).loadAll();
      arenas[category] = {
        meta: CATEGORY_META[category],
        // The full public task is what competitors actually receive (see
        // buildCompetitorPrompt); exposing it lets the UI show the real prompt.
        // The private rubric and expected resolution never leave the server.
        tasks: tasks.map((task) => ({
          id: task.public.id,
          version: task.public.version,
          category: task.public.category,
          title: task.public.title,
          cluster: task.public.cluster,
          difficulty: task.public.difficulty,
          summary: task.public.summary,
          prompt: task.public.prompt,
          artifacts: task.public.artifacts,
          tags: task.public.tags,
          publicHash: task.publicHash,
        })),
        snapshot: buildSnapshot(createStore(category).readAll(), category),
      };
    }
    json(response, 200, {
      run: state,
      hasApiKey: Boolean(process.env.OPENROUTER_API_KEY),
      models: listModels().map(({ id, displayName, vendor, role }) => ({ id, displayName, vendor, role })),
      categories: CATEGORIES,
      arenas,
      events,
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    setSecurityHeaders(response);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/runs') {
    if (!isAllowedMutation(request)) {
      json(response, 403, { error: 'Run requests require same-origin application/json' });
      return true;
    }
    if (state.status === 'running') {
      json(response, 409, { error: 'An arena run is already active' });
      return true;
    }
    if (!process.env.OPENROUTER_API_KEY) loadProjectEnv();
    if (!process.env.OPENROUTER_API_KEY) {
      json(response, 503, { error: `OPENROUTER_API_KEY is not configured; set it in ${ENV_PATH} or the dashboard environment` });
      return true;
    }
    try {
      const config = RunRequestSchema.parse(await readJson(request));
      void startRun(config);
      json(response, 202, { accepted: true, config });
    } catch (error) {
      json(response, 400, { error: error instanceof z.ZodError ? 'Invalid run configuration' : sanitizeError(error) });
    }
    return true;
  }

  json(response, 404, { error: 'API route not found' });
  return true;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function serveProduction(request: IncomingMessage, response: ServerResponse): void {
  const pathname = new URL(request.url ?? '/', `http://${HOST}:${PORT}`).pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  let target = path.resolve(UI_DIST, relative);
  if (!target.startsWith(`${UI_DIST}${path.sep}`) || !existsSync(target) || statSync(target).isDirectory()) {
    target = path.join(UI_DIST, 'index.html');
  }
  setSecurityHeaders(response);
  response.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(response);
}

export async function startDashboardServer(): Promise<void> {
  const production = process.env.NODE_ENV === 'production';
  const vite = production
    ? null
    : await import('vite').then(({ createServer: createViteServer }) =>
        createViteServer({
          root: UI_ROOT,
          server: { middlewareMode: true, host: HOST, hmr: { host: HOST } },
          appType: 'spa',
        }),
      );
  const server = createServer(async (request, response) => {
    try {
      if (await apiHandler(request, response)) return;
      if (vite) {
        // Vite injects one inline React Refresh module in development. Keep
        // this exception out of API responses and the production dashboard.
        setSecurityHeaders(response, true);
        vite.middlewares(request, response, () => json(response, 404, { error: 'Not found' }));
      } else {
        serveProduction(request, response);
      }
    } catch (error) {
      json(response, 500, { error: sanitizeError(error) });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`BridgeBench V3 dashboard: http://${HOST}:${PORT}`);
    console.log(
      `OpenRouter key: ${process.env.OPENROUTER_API_KEY ? 'configured' : `not configured (set OPENROUTER_API_KEY in ${ENV_PATH})`}`,
    );
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
  }, 15_000);
  server.on('close', () => clearInterval(heartbeat));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboardServer().catch((error) => {
    console.error(`BridgeBench V3 dashboard: ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}
