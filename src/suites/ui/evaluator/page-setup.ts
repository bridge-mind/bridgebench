/**
 * Per-artifact page environment:
 *
 * - Synthetic same-origin host (http://ui-bench.local) so root-relative
 *   /vendor/… URLs resolve exactly as they will on bridgebench.ai. The
 *   document and vendor files are fulfilled from disk; EVERYTHING else is
 *   aborted and counted (hermetic eval).
 * - Init script installs the harness spy: canvas-context recorder (catches
 *   WebGL that the legacy 2D-only detector missed), a rAF frame counter,
 *   and the unmasked GL renderer string.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import type { BrowserContext, Page } from 'playwright-core';

import { VENDOR_DIR } from '../../../config.js';

export const EVAL_ORIGIN = 'http://ui-bench.local';
export const ARTIFACT_PATH = '/artifact.html';

export interface NetworkCounters {
  blocked: number;
  vendorServed: number;
  blockedUrls: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
};

export async function installRoutes(
  context: BrowserContext,
  artifactHtml: string,
): Promise<NetworkCounters> {
  const counters: NetworkCounters = { blocked: 0, vendorServed: 0, blockedUrls: [] };

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());

    if (url.origin === EVAL_ORIGIN) {
      if (url.pathname === ARTIFACT_PATH) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: artifactHtml,
        });
        return;
      }

      // Browsers request /favicon.ico on navigation — not artifact behavior.
      if (url.pathname === '/favicon.ico') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }

      if (url.pathname.startsWith('/vendor/')) {
        const relative = url.pathname.slice('/vendor/'.length);
        const filePath = path.resolve(VENDOR_DIR, relative);
        if (
          filePath.startsWith(VENDOR_DIR + path.sep) &&
          existsSync(filePath) &&
          statSync(filePath).isFile()
        ) {
          counters.vendorServed++;
          await route.fulfill({
            status: 200,
            contentType:
              CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
            body: readFileSync(filePath),
          });
          return;
        }
        counters.blocked++;
        counters.blockedUrls.push(url.href);
        await route.abort('failed');
        return;
      }
    }

    counters.blocked++;
    counters.blockedUrls.push(url.href.slice(0, 200));
    await route.abort('failed');
  });

  return counters;
}

/** Injected before any page script runs. */
const HARNESS_SPY = `(() => {
  const requested = [];
  let renderer = null;
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = orig.call(this, type, ...args);
    if (ctx && !requested.includes(type)) requested.push(type);
    if (ctx && (type === 'webgl' || type === 'webgl2') && renderer === null) {
      try {
        const ext = ctx.getExtension('WEBGL_debug_renderer_info');
        renderer = ext
          ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)
          : ctx.getParameter(ctx.RENDERER);
      } catch { /* renderer stays null */ }
    }
    return ctx;
  };
  let rafFrames = 0;
  const rafOrig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    rafOrig((t) => {
      rafFrames++;
      return cb(t);
    });
  Object.defineProperty(window, '__bridgebenchSpy', {
    value: {
      get requestedContexts() { return [...requested]; },
      get glRenderer() { return renderer; },
      get rafFrames() { return rafFrames; },
    },
  });
})();`;

export async function installHarnessSpy(context: BrowserContext): Promise<void> {
  await context.addInitScript(HARNESS_SPY);
}

export interface ConsoleCapture {
  errors: number;
  warnings: number;
  sample: Array<{ type: string; text: string }>;
  pageErrors: Array<{ text: string; atMs: number }>;
}

export function captureConsole(page: Page, startedAt: number): ConsoleCapture {
  const capture: ConsoleCapture = { errors: 0, warnings: 0, sample: [], pageErrors: [] };

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error') capture.errors++;
    if (type === 'warning') capture.warnings++;
    if (capture.sample.length < 20) {
      capture.sample.push({ type, text: msg.text().slice(0, 300) });
    }
  });

  page.on('pageerror', (error) => {
    capture.pageErrors.push({
      text: String(error?.message ?? error).slice(0, 500),
      atMs: Date.now() - startedAt,
    });
  });

  return capture;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
