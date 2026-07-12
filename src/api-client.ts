import { z } from 'zod';

import { redactSecrets } from './logger.js';

export const ADMIN_KEY_HEADER = 'x-bridgebench-admin-key';
export const DEFAULT_API_TIMEOUT_MS = 30_000;
export const REQUEST_SPACING_MS = 700;

export interface ApiConfig {
  baseUrl: string;
  adminKey: string;
  timeoutMs: number;
}

export function resolveApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const configuredUrl = environment.BRIDGEBENCH_API_URL?.trim();
  if (!configuredUrl) {
    throw new Error('Set BRIDGEBENCH_API_URL to the exact API target before publishing.');
  }
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error('BRIDGEBENCH_API_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('BRIDGEBENCH_API_URL must be an HTTP(S) URL without embedded credentials.');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('BRIDGEBENCH_API_URL must use HTTPS unless it targets localhost.');
  }
  const baseUrl = configuredUrl.replace(/\/+$/, '');
  const adminKey = environment.BRIDGEBENCH_ADMIN_KEY?.trim() ?? '';
  if (!adminKey) {
    throw new Error('Set BRIDGEBENCH_ADMIN_KEY before publishing.');
  }
  return { baseUrl, adminKey, timeoutMs: DEFAULT_API_TIMEOUT_MS };
}

export function publishTarget(config: ApiConfig): string {
  return new URL(config.baseUrl).origin;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function adminHeaders(config: ApiConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    [ADMIN_KEY_HEADER]: config.adminKey,
  };
}

export async function getJson<T>(
  config: ApiConfig,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      [ADMIN_KEY_HEADER]: config.adminKey,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} → ${response.status}: ${redactSecrets(text).slice(0, 500)}`);
  }
  let decoded: unknown;
  try {
    decoded = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GET ${path} returned invalid JSON`);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`GET ${path} returned an invalid response contract`);
  }
  return parsed.data;
}

const THROTTLE_RETRY_LIMIT = 5;
const THROTTLE_RETRY_BASE_MS = 1_200;

export async function postJson<T>(
  config: ApiConfig,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  let text: string;
  let attempt = 0;
  for (;;) {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: adminHeaders(config),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    text = await response.text();
    if (response.status === 429 && attempt < THROTTLE_RETRY_LIMIT) {
      attempt += 1;
      await delay(THROTTLE_RETRY_BASE_MS * attempt);
      continue;
    }
    break;
  }
  if (!response.ok) {
    throw new Error(`POST ${path} → ${response.status}: ${redactSecrets(text).slice(0, 500)}`);
  }
  let decoded: unknown;
  try {
    decoded = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`POST ${path} returned invalid JSON`);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`POST ${path} returned an invalid response contract`);
  }
  return parsed.data;
}

export async function postChunks<T, R extends { imported?: number; skipped?: number }>(
  config: ApiConfig,
  path: string,
  batches: readonly T[][],
  wrap: (batch: readonly T[]) => Record<string, readonly T[]>,
  schema: z.ZodType<R>,
): Promise<R[]> {
  const results: R[] = [];
  let first = true;
  for (const batch of batches) {
    if (!first) await delay(REQUEST_SPACING_MS);
    first = false;
    results.push(await postJson(config, path, wrap(batch), schema));
  }
  return results;
}
