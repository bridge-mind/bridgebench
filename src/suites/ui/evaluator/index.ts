/**
 * Artifact evaluator — orchestrates the two-phase Playwright evaluation.
 *
 * Phase A (real time): load on the synthetic origin, verify harness globals,
 * record WebGL context + renderer, sample rAF FPS, detect animation via
 * composited-screenshot pixel diffs (works for WebGL — the legacy 2D
 * getImageData path could not see it), capture gallery screenshots, run the
 * hidden interaction probes, smoke getScore()/destroy().
 *
 * Phase B (virtual time): reset-replay determinism check in a fresh page —
 * see determinism.ts.
 *
 * Security note: no JS eval() here — page.evaluate()/$$eval are Playwright
 * APIs running script inside the sandboxed, network-blocked page context,
 * which is this harness's purpose.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Browser } from 'playwright-core';

import type {
  UiArtifactEvaluationResult,
  UiBenchFullTask,
  UiProbeResult,
} from '../types.js';
import {
  ARTIFACT_PATH,
  EVAL_ORIGIN,
  captureConsole,
  installHarnessSpy,
  installRoutes,
} from './page-setup.js';
import { changedPixelPct, isBlankFrame } from './pixels.js';
import { ProbeInterpreter } from './probes.js';
import { runDeterminismPhase } from './determinism.js';

const SETTLE_MS = 3_000;
const GLOBALS_TIMEOUT_MS = 5_000;
const ANIMATION_SAMPLE_OFFSETS = [0, 700, 1400];
const FPS_SAMPLE_MS = 2_000;
export const DEFAULT_MOTION_MIN_CHANGED_PCT = 0.8;

export interface UiEvaluateOptions {
  html: string;
  task: UiBenchFullTask;
  outputDir: string;
  executablePath: string;
}

export class UiArtifactEvaluator {
  constructor(private readonly browser: Browser) {}

  async evaluate(options: UiEvaluateOptions): Promise<UiArtifactEvaluationResult> {
    const startedAt = Date.now();
    const { task } = options;
    const viewport = task.viewport;

    await fs.mkdir(options.outputDir, { recursive: true });

    const context = await this.browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
    });

    try {
      await installHarnessSpy(context);
      const network = await installRoutes(context, options.html);

      const page = await context.newPage();
      const consoleCapture = captureConsole(page, startedAt);

      const base: UiArtifactEvaluationResult = {
        ok: false,
        evaluationTimeMs: 0,
        browser: { executablePath: options.executablePath, viewport },
        consoleErrorCount: 0,
        consoleWarningCount: 0,
        consoleSample: [],
        pageErrors: [],
        networkRequestsBlocked: 0,
        vendorRequestsServed: 0,
        startupTimeMs: 0,
        harnessGlobalsMs: null,
        webgl: { requestedContexts: [], active: null, renderer: null },
        fps: null,
        animation: { detected: false, changedPct: [] },
        blankFrame: true,
        screenshots: {},
        probes: null,
        determinism: { ran: false, replayChangedPct: null, statesMatch: null },
        controlsFound: [],
        viewportFill: false,
        getScoreOk: false,
        destroyOk: false,
      };

      // ── Load ────────────────────────────────────────────────────────
      const loadStart = Date.now();
      try {
        await page.goto(EVAL_ORIGIN + ARTIFACT_PATH, {
          waitUntil: 'load',
          timeout: 20_000,
        });
      } catch (error) {
        return this.finish(base, consoleCapture, network, startedAt, {
          error: `Page load failed: ${error instanceof Error ? error.message : error}`,
        });
      }
      base.startupTimeMs = Date.now() - loadStart;

      const globalsStart = Date.now();
      const hasGlobals = await page
        .waitForFunction(
          () =>
            Boolean((window as any).BridgeBenchTaskApi) &&
            Boolean((window as any).BridgeBenchTaskManifest),
          undefined,
          { timeout: GLOBALS_TIMEOUT_MS },
        )
        .then(() => true)
        .catch(() => false);
      base.harnessGlobalsMs = hasGlobals ? Date.now() - globalsStart + base.startupTimeMs : null;

      // ── Settle (SwiftShader shader compilation is slow) ─────────────
      await page.waitForTimeout(SETTLE_MS);

      const interpreter = new ProbeInterpreter(page, options.outputDir);

      // ── FPS sampling window (concurrent with animation sampling) ────
      const framesBefore = await page
        .evaluate(() => (window as any).__bridgebenchSpy?.rafFrames ?? 0)
        .catch(() => 0);
      const fpsWindowStart = Date.now();

      // ── Animation sampling + gallery screenshots on one timeline ────
      const timelineStart = Date.now();
      const events: Array<{ at: number; kind: 'anim' | 'gallery'; name: string }> = [
        ...ANIMATION_SAMPLE_OFFSETS.map((at, i) => ({
          at,
          kind: 'anim' as const,
          name: `anim-${i}`,
        })),
        ...task.screenshots.map((s) => ({ at: s.at, kind: 'gallery' as const, name: s.name })),
      ].sort((a, b) => a.at - b.at);

      const animShots: Buffer[] = [];
      for (const event of events) {
        const wait = event.at - (Date.now() - timelineStart);
        if (wait > 0) await page.waitForTimeout(wait);
        if (event.kind === 'anim') {
          animShots.push(await interpreter.captureRegion());
        } else {
          const shot = await page.screenshot({ fullPage: false });
          const shotPath = path.join(options.outputDir, `${event.name}.png`);
          await fs.writeFile(shotPath, shot);
          base.screenshots[event.name] = shotPath;
        }
      }

      // ── FPS ────────────────────────────────────────────────────────
      const elapsedFpsWindow = Date.now() - fpsWindowStart;
      const remainingFps = FPS_SAMPLE_MS - elapsedFpsWindow;
      if (remainingFps > 0) await page.waitForTimeout(remainingFps);
      const framesAfter = await page
        .evaluate(() => (window as any).__bridgebenchSpy?.rafFrames ?? 0)
        .catch(() => 0);
      const fpsWindowMs = Date.now() - fpsWindowStart;
      base.fps =
        fpsWindowMs > 0
          ? Number((((framesAfter as number) - (framesBefore as number)) / (fpsWindowMs / 1000)).toFixed(1))
          : null;

      // ── Animation detection ────────────────────────────────────────
      const motionThreshold =
        task.scoringOverrides?.motionMinChangedPct ?? DEFAULT_MOTION_MIN_CHANGED_PCT;
      for (let i = 1; i < animShots.length; i++) {
        base.animation.changedPct.push(
          Number(changedPixelPct(animShots[i - 1], animShots[i]).toFixed(3)),
        );
      }
      base.animation.detected = base.animation.changedPct.some((pct) => pct >= motionThreshold);
      base.blankFrame = animShots.length > 0 ? isBlankFrame(animShots[0]) : true;

      // ── Spy data ───────────────────────────────────────────────────
      const spy = (await page
        .evaluate(() => {
          const s = (window as any).__bridgebenchSpy;
          return s
            ? { requestedContexts: s.requestedContexts, glRenderer: s.glRenderer }
            : { requestedContexts: [], glRenderer: null };
        })
        .catch(() => ({ requestedContexts: [], glRenderer: null }))) as {
        requestedContexts: string[];
        glRenderer: string | null;
      };
      base.webgl.requestedContexts = spy.requestedContexts;
      base.webgl.renderer = spy.glRenderer;
      base.webgl.active = spy.requestedContexts.includes('webgl2')
        ? 'webgl2'
        : spy.requestedContexts.includes('webgl')
          ? 'webgl'
          : spy.requestedContexts.includes('2d')
            ? '2d'
            : null;

      // ── Controls + viewport fill ───────────────────────────────────
      base.controlsFound = (await page
        .$$eval('[data-bb-control]', (els) =>
          els.map((el) => el.getAttribute('data-bb-control')).filter(Boolean),
        )
        .catch(() => [])) as string[];

      base.viewportFill = (await page
        .evaluate(() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let best = 0;
          for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
            const rect = canvas.getBoundingClientRect();
            best = Math.max(best, (rect.width * rect.height) / (vw * vh));
          }
          if (best >= 0.85) return true;
          const body = document.body;
          return body
            ? body.scrollWidth >= vw * 0.95 && body.scrollHeight >= vh * 0.95 && best === 0
            : false;
        })
        .catch(() => false)) as boolean;

      // ── Hidden interaction probes ──────────────────────────────────
      if (task.probes && hasGlobals) {
        const results: UiProbeResult[] = [];
        for (const probe of task.probes) {
          results.push(await interpreter.runProbe(probe));
        }
        base.probes = results;
      }

      // ── TaskApi smoke ──────────────────────────────────────────────
      if (hasGlobals) {
        base.getScoreOk = await page
          .evaluate(() => {
            (window as any).BridgeBenchTaskApi.getScore?.();
            return true;
          })
          .catch(() => false);
        base.destroyOk = await page
          .evaluate(() => {
            (window as any).BridgeBenchTaskApi.destroy?.();
            return true;
          })
          .catch(() => false);
      }

      await page.close();

      // ── Phase B — determinism replay under virtual time ────────────
      if (hasGlobals) {
        const determinism = await runDeterminismPhase(context, { viewport });
        base.determinism = {
          ran: determinism.ran,
          replayChangedPct: determinism.replayChangedPct,
          statesMatch: determinism.statesMatch,
          ...(determinism.error ? { error: determinism.error } : {}),
        };
        if (determinism.shots) {
          await fs.writeFile(
            path.join(options.outputDir, 'determinism-a.png'),
            determinism.shots[0],
          );
          await fs.writeFile(
            path.join(options.outputDir, 'determinism-b.png'),
            determinism.shots[1],
          );
        }
      }

      return this.finish(base, consoleCapture, network, startedAt, { ok: true });
    } finally {
      await context.close().catch(() => {});
    }
  }

  private finish(
    base: UiArtifactEvaluationResult,
    consoleCapture: ReturnType<typeof captureConsole>,
    network: { blocked: number; vendorServed: number },
    startedAt: number,
    outcome: { ok?: boolean; error?: string },
  ): UiArtifactEvaluationResult {
    base.ok = outcome.ok ?? false;
    if (outcome.error) base.error = outcome.error;
    base.consoleErrorCount = consoleCapture.errors;
    base.consoleWarningCount = consoleCapture.warnings;
    base.consoleSample = consoleCapture.sample;
    base.pageErrors = consoleCapture.pageErrors.map(
      (e) => `[${e.atMs}ms] ${e.text}`,
    );
    base.networkRequestsBlocked = network.blocked;
    base.vendorRequestsServed = network.vendorServed;
    base.evaluationTimeMs = Date.now() - startedAt;
    return base;
  }
}

export { launchEvalBrowser, resolveChromiumExecutablePath } from './browser.js';
