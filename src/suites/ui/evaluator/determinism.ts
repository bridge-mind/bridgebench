/**
 * Phase B — determinism replay under virtual time.
 *
 * A fresh page gets Playwright fake timers (page.clock virtualizes
 * Date.now, performance.now, timers, and rAF), then:
 *   reset(42) → run 1500 virtual ms → screenshot + getState
 *   reset(42) → run 1500 virtual ms → screenshot + getState
 * Identical seeds must replay identically: the screenshots are compared
 * with a pixel tolerance and the states must deep-equal. Runs in its own
 * page so fake timers never contaminate Phase A's FPS/motion sampling.
 */

import type { BrowserContext } from 'playwright-core';

import type { UiArtifactEvaluationResult } from '../types.js';
import { EVAL_ORIGIN, ARTIFACT_PATH } from './page-setup.js';
import { changedPixelPct } from './pixels.js';
import { ProbeInterpreter, stableJson } from './probes.js';

export const DETERMINISM_SEED = 42;
export const DETERMINISM_RUN_MS = 1500;

export async function runDeterminismPhase(
  context: BrowserContext,
  options: { viewport: { width: number; height: number } },
): Promise<UiArtifactEvaluationResult['determinism'] & { shots?: [Buffer, Buffer] }> {
  const page = await context.newPage();

  try {
    await page.setViewportSize(options.viewport);
    await page.clock.install();
    await page.goto(EVAL_ORIGIN + ARTIFACT_PATH, { waitUntil: 'load', timeout: 20_000 });

    const hasGlobals = await page
      .waitForFunction(
        () =>
          Boolean((window as any).BridgeBenchTaskApi) &&
          Boolean((window as any).BridgeBenchTaskManifest),
        undefined,
        { timeout: 5_000 },
      )
      .then(() => true)
      .catch(() => false);

    if (!hasGlobals) {
      return {
        ran: false,
        replayChangedPct: null,
        statesMatch: null,
        error: 'harness globals missing',
      };
    }

    // Let module scripts finish any setup scheduled behind fake timers.
    await page.clock.runFor(500);

    const interpreter = new ProbeInterpreter(page, null);

    const runOnce = async (): Promise<{ shot: Buffer; state: string }> => {
      await page.evaluate(
        (seed) => (window as any).BridgeBenchTaskApi.reset(seed),
        DETERMINISM_SEED,
      );
      await page.clock.runFor(DETERMINISM_RUN_MS);
      const shot = await interpreter.captureRegion();
      const state = await page.evaluate(() => {
        const api = (window as any).BridgeBenchTaskApi;
        return JSON.stringify(api?.getState?.() ?? null);
      });
      return { shot, state: stableJson(JSON.parse(state)) };
    };

    const first = await runOnce();
    const second = await runOnce();

    return {
      ran: true,
      replayChangedPct: Number(changedPixelPct(first.shot, second.shot).toFixed(3)),
      statesMatch: first.state === second.state,
      shots: [first.shot, second.shot],
    };
  } catch (error) {
    return {
      ran: false,
      replayChangedPct: null,
      statesMatch: null,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  } finally {
    await page.close().catch(() => {});
  }
}
