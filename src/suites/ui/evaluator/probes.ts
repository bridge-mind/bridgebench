/**
 * Probe DSL interpreter — the replacement for the legacy static-string
 * "interactivity detection". Each probe drives REAL input (clicks, drags,
 * wheel, sliders, keys) against the live artifact and asserts observable
 * effects: pixel deltas, hue shifts, or BridgeBenchTaskApi state changes.
 *
 * Probes are hidden during a season (bridgebench-private) and published to
 * tasks/retired/ when the season rotates.
 *
 * Security note: this file contains no JS eval(). All `page.evaluate()`
 * calls are Playwright's API for running script inside the sandboxed,
 * network-blocked browser page — evaluating untrusted model artifacts in
 * that isolated context is exactly this harness's job.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Page } from 'playwright-core';

import type { ProbeAssert, ProbeStep, UiProbe, UiProbeResult } from '../types.js';
import { changedPixelPct, dominantHue, hueDistance, meanLuminance } from './pixels.js';

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ProbeInterpreter {
  private snapshots = new Map<string, Buffer>();
  private states = new Map<string, unknown>();

  constructor(
    private readonly page: Page,
    private readonly auditDir: string | null,
  ) {}

  async runProbe(probe: UiProbe): Promise<UiProbeResult> {
    this.snapshots.clear();
    this.states.clear();

    try {
      for (const step of probe.steps) {
        await this.runStep(step);
      }

      const failures: string[] = [];
      for (const assert of probe.asserts) {
        const result = await this.evaluateAssert(assert);
        if (!result.passed) failures.push(result.detail);
      }

      if (this.auditDir) {
        const shot = await this.captureRegion();
        await fs.writeFile(path.join(this.auditDir, `probe-${probe.id}.png`), shot);
      }

      return {
        id: probe.id,
        weight: probe.weight,
        passed: failures.length === 0,
        details: failures.length > 0 ? failures.join('; ') : undefined,
      };
    } catch (error) {
      return {
        id: probe.id,
        weight: probe.weight,
        passed: false,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      };
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────

  private async runStep(step: ProbeStep): Promise<void> {
    switch (step.action) {
      case 'reset':
        await this.page.evaluate(
          (seed) => (window as any).BridgeBenchTaskApi.reset(seed),
          step.seed,
        );
        return;

      case 'waitMs':
        await this.page.waitForTimeout(step.ms);
        return;

      case 'snapshot':
        this.snapshots.set(step.name, await this.captureRegion());
        return;

      case 'getState':
        this.states.set(step.name, await this.readState());
        return;

      case 'click': {
        if (step.selector) {
          await this.page.click(step.selector, { timeout: 3000 });
          return;
        }
        const point = await this.regionPoint(step.at ?? { xPct: 50, yPct: 50 });
        await this.page.mouse.click(point.x, point.y);
        return;
      }

      case 'drag': {
        const from = await this.regionPoint(step.from);
        const to = await this.regionPoint(step.to);
        await this.page.mouse.move(from.x, from.y);
        await this.page.mouse.down();
        const steps = step.steps ?? 12;
        for (let i = 1; i <= steps; i++) {
          await this.page.mouse.move(
            from.x + ((to.x - from.x) * i) / steps,
            from.y + ((to.y - from.y) * i) / steps,
          );
        }
        await this.page.mouse.up();
        return;
      }

      case 'wheel': {
        const point = await this.regionPoint(step.at ?? { xPct: 50, yPct: 50 });
        await this.page.mouse.move(point.x, point.y);
        await this.page.mouse.wheel(0, step.deltaY);
        return;
      }

      case 'setSlider': {
        const handled = await this.page.evaluate(
          ({ selector, fraction }) => {
            const el = document.querySelector(selector) as HTMLInputElement | null;
            if (!el) return 'missing';
            if (el.tagName === 'INPUT' && el.type === 'range') {
              const min = Number(el.min || 0);
              const max = Number(el.max || 100);
              const step = Number(el.step || 1) || 1;
              const raw = min + fraction * (max - min);
              el.value = String(Math.round(raw / step) * step);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'input';
            }
            return 'custom';
          },
          { selector: step.selector, fraction: step.fraction },
        );

        if (handled === 'missing') {
          throw new Error(`setSlider: no element matches ${step.selector}`);
        }
        if (handled === 'custom') {
          // Custom slider widget: click at the fraction across its box.
          const box = await this.page.locator(step.selector).boundingBox();
          if (!box) throw new Error(`setSlider: ${step.selector} has no bounding box`);
          await this.page.mouse.click(box.x + box.width * step.fraction, box.y + box.height / 2);
        }
        return;
      }

      case 'press':
        await this.page.keyboard.press(step.key);
        return;

      case 'move': {
        const point = await this.regionPoint(step.to);
        await this.page.mouse.move(point.x, point.y, { steps: 8 });
        return;
      }
    }
  }

  // ── Asserts ──────────────────────────────────────────────────────────

  private async evaluateAssert(assert: ProbeAssert): Promise<{ passed: boolean; detail: string }> {
    if ('anyOf' in assert) {
      const details: string[] = [];
      for (const inner of assert.anyOf) {
        const result = await this.evaluateAssert(inner);
        if (result.passed) return { passed: true, detail: '' };
        details.push(result.detail);
      }
      return { passed: false, detail: `anyOf failed: [${details.join(' | ')}]` };
    }

    switch (assert.type) {
      case 'pixelDeltaVs': {
        const ref = this.requireSnapshot(assert.ref);
        const current = await this.captureRegion();
        const pct = changedPixelPct(ref, current);
        return {
          passed: pct >= assert.minChangedPct,
          detail: `pixelDeltaVs ${assert.ref}: ${pct.toFixed(2)}% changed (need ≥${assert.minChangedPct}%)`,
        };
      }

      case 'pixelDeltaBelow': {
        const ref = this.requireSnapshot(assert.ref);
        const current = await this.captureRegion();
        const pct = changedPixelPct(ref, current);
        return {
          passed: pct <= assert.maxChangedPct,
          detail: `pixelDeltaBelow ${assert.ref}: ${pct.toFixed(2)}% changed (need ≤${assert.maxChangedPct}%)`,
        };
      }

      case 'hueShiftVs': {
        const ref = this.requireSnapshot(assert.ref);
        const current = await this.captureRegion();
        const hueA = dominantHue(ref);
        const hueB = dominantHue(current);
        if (hueA === null || hueB === null) {
          return { passed: false, detail: 'hueShiftVs: could not extract a dominant hue' };
        }
        const distance = hueDistance(hueA, hueB);
        return {
          passed: distance >= assert.minDegrees,
          detail: `hueShiftVs ${assert.ref}: ${distance.toFixed(1)}° (need ≥${assert.minDegrees}°)`,
        };
      }

      case 'motionIncreased': {
        const slow = changedPixelPct(
          this.requireSnapshot(assert.slowA),
          this.requireSnapshot(assert.slowB),
        );
        const fast = changedPixelPct(
          this.requireSnapshot(assert.fastA),
          this.requireSnapshot(assert.fastB),
        );
        // Guard the zero-motion baseline with a small floor.
        const passed = fast >= Math.max(slow, 0.05) * assert.minFactor;
        return {
          passed,
          detail: `motionIncreased: slow ${slow.toFixed(2)}% → fast ${fast.toFixed(2)}% (need ≥${assert.minFactor}×)`,
        };
      }

      case 'luminanceRatioVs': {
        const ref = meanLuminance(this.requireSnapshot(assert.ref));
        const current = meanLuminance(await this.captureRegion());
        const ratio = ref <= 0.5 ? (current > 0.5 ? Infinity : 1) : current / ref;
        const minOk = assert.minRatio === undefined || ratio >= assert.minRatio;
        const maxOk = assert.maxRatio === undefined || ratio <= assert.maxRatio;
        return {
          passed: minOk && maxOk,
          detail: `luminanceRatioVs ${assert.ref}: ×${ratio.toFixed(2)} (need ${assert.minRatio ? `≥${assert.minRatio}` : ''}${assert.maxRatio ? ` ≤${assert.maxRatio}` : ''})`,
        };
      }

      case 'stateChangedVs': {
        const ref = this.states.get(assert.ref);
        if (ref === undefined) {
          return { passed: false, detail: `stateChangedVs: no recorded state "${assert.ref}"` };
        }
        const current = await this.readState();
        const before = stableJson(assert.path ? pluck(ref, assert.path) : ref);
        const after = stableJson(assert.path ? pluck(current, assert.path) : current);
        return {
          passed: before !== after,
          detail: `stateChangedVs ${assert.ref}${assert.path ? `.${assert.path}` : ''}: unchanged`,
        };
      }

      case 'stateUnchangedVs': {
        const ref = this.states.get(assert.ref);
        if (ref === undefined) {
          return { passed: false, detail: `stateUnchangedVs: no recorded state "${assert.ref}"` };
        }
        const current = await this.readState();
        const before = stableJson(assert.path ? pluck(ref, assert.path) : ref);
        const after = stableJson(assert.path ? pluck(current, assert.path) : current);
        return {
          passed: before === after,
          detail: `stateUnchangedVs ${assert.ref}: state drifted without interaction (clock/frame counter in getState?)`,
        };
      }

      case 'statePathExists': {
        const current = await this.readState();
        return {
          passed: pluck(current, assert.path) !== undefined,
          detail: `statePathExists: "${assert.path}" missing from getState()`,
        };
      }

      case 'stateSerializable': {
        try {
          const current = await this.readState();
          return {
            passed: current !== undefined && current !== null,
            detail: 'stateSerializable: getState() returned null/undefined',
          };
        } catch (error) {
          return {
            passed: false,
            detail: `stateSerializable: ${error instanceof Error ? error.message : error}`,
          };
        }
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private requireSnapshot(name: string): Buffer {
    const snapshot = this.snapshots.get(name);
    if (!snapshot) throw new Error(`No snapshot named "${name}" was taken`);
    return snapshot;
  }

  private async readState(): Promise<unknown> {
    return this.page.evaluate(() => {
      const api = (window as any).BridgeBenchTaskApi;
      const state = api?.getState?.();
      return JSON.parse(JSON.stringify(state ?? null));
    });
  }

  /** The scored region: the tagged scene canvas, else the largest canvas, else viewport. */
  async region(): Promise<Region> {
    const tagged = this.page.locator('canvas[data-bb-control="scene-canvas"]').first();
    if ((await tagged.count()) > 0) {
      const box = await tagged.boundingBox();
      if (box && box.width > 10 && box.height > 10) return clampRegion(box, this.page);
    }

    const boxes = await this.page.$$eval('canvas', (canvases) =>
      canvases.map((c) => {
        const rect = c.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
    const largest = boxes
      .filter((b) => b.width > 10 && b.height > 10)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (largest) return clampRegion(largest, this.page);

    const viewport = this.page.viewportSize() ?? { width: 1280, height: 800 };
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }

  async captureRegion(): Promise<Buffer> {
    const clip = await this.region();
    return this.page.screenshot({ clip, animations: 'allow' });
  }

  private async regionPoint(pct: {
    xPct: number;
    yPct: number;
  }): Promise<{ x: number; y: number }> {
    const region = await this.region();
    return {
      x: region.x + (region.width * pct.xPct) / 100,
      y: region.y + (region.height * pct.yPct) / 100,
    };
  }
}

function clampRegion(box: Region, page: Page): Region {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return {
    x,
    y,
    width: Math.min(box.width, viewport.width - x),
    height: Math.min(box.height, viewport.height - y),
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

function pluck(value: unknown, dotPath: string): unknown {
  let current: any = value;
  for (const key of dotPath.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}
