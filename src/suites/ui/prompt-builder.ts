/**
 * Builds the full prompt sent to a model for a UI Bench task.
 *
 * The system prompt is the artifact contract: one self-contained HTML file
 * whose ONLY external references are the pinned, same-origin three.js import
 * map quoted verbatim below. Everything here is enforced by validator.ts and
 * exercised by the evaluator — keep the three in lockstep.
 */

import { CANONICAL_IMPORT_MAP_JSON, THREE_VERSION } from '../../config.js';
import type { UiBenchTask } from './types.js';

export function buildImportMapBlock(): string {
  return `<script type="importmap">\n${CANONICAL_IMPORT_MAP_JSON}\n</script>`;
}

export function buildUiSystemPrompt(task: UiBenchTask): string {
  const importMapBlock = buildImportMapBlock();

  const controlsSection =
    task.controls.length === 0
      ? 'This task declares no required controls.'
      : task.controls
          .map(
            (control) =>
              `   - ${control.kind} "${control.label}": add the attribute data-bb-control="${control.id}" to the element. Behavior: ${control.behavior}`,
          )
          .join('\n');

  return `You are an expert frontend developer, creative coder, and 3D graphics artist.
Create a single, self-contained HTML file that implements the requested scene.

RULES:
1. Output ONLY the complete HTML file — starting with <!DOCTYPE html> and ending with </html>. No markdown fences, no commentary.
2. three.js ${THREE_VERSION} is available via this exact import map. If you use three.js, include this block in <head> BEFORE your module script, byte-for-byte:

${importMapBlock}

   Then import it in a <script type="module"> block:
   import * as THREE from 'three';
   import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
   import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
   (addons under three/addons/ mirror the official examples/jsm layout: controls, postprocessing, shaders, math, geometries, objects, lines, effects, curves, utils, misc)
3. The import map above is the ONLY permitted external reference. No other CDNs, libraries, fonts, images, network requests, fetch/XMLHttpRequest/WebSocket, or Web Workers. All textures must be procedural (canvas-generated or DataTexture). Do NOT load font files — if you need text, render it to an offscreen 2D canvas and use it as a texture or sample it for particle positions.
4. All CSS in <style> tags, all of your own JavaScript inline in <script> tags.
5. The scene must fill the full viewport, hide scrollbars, and be responsive to window resizing.
6. Rendering starts immediately on page load — no start buttons, no user gesture required.
7. Make it breathtaking. Prioritize lighting, color, motion quality, and detail. This artifact will be judged next to the best frontier models' output.
8. Required on-screen controls (keep them minimal and elegant — small overlay UI):
${controlsSection}
9. The document MUST define BOTH BridgeBench harness globals in an inline script:

   window.BridgeBenchTaskManifest = {
     benchmarkVersion: "3.0",
     taskId: "${task.id}",
     title: "${task.title}",
     category: "${task.category}",
     controls: [${task.controls.map((c) => `"${c.id}"`).join(', ')}],
     deterministic: true,
     preferredViewport: { width: ${task.viewport.width}, height: ${task.viewport.height} }
   };

   window.BridgeBenchTaskApi = {
     init() { /* optional setup */ },
     reset(seed) { /* restart the scene deterministically from this numeric seed */ },
     getState() { /* return a JSON-serializable snapshot of current scene state */ },
     getScore() { return null; },
     destroy() { /* stop timers and animation frames */ }
   };

10. Determinism contract (scored): ALL randomness must flow from a seeded PRNG (e.g. mulberry32) initialized in reset(seed) — never call Math.random() directly at animation time. Drive animation from requestAnimationFrame timestamps or performance.now(), never Date.now(). Calling reset(S) twice must produce pixel-identical scenes at the same elapsed time.
11. getState() must return a small JSON-serializable object describing scene CONFIGURATION (e.g. current speed setting, palette index, object count, seed) — it is called by the harness and compared across resets and interactions. It must NOT include clocks, elapsed time, or frame counters: calling getState() twice with no user interaction in between must return identical objects, and every user-visible control change must be reflected in it.`;
}

/** The task half of the prompt — sent as the user message by the live runner. */
export function buildUiUserPrompt(task: UiBenchTask): string {
  return [`Task ID: ${task.id}`, `Task title: ${task.title}`, '', task.prompt.trim()].join('\n');
}

export function buildUiTaskPrompt(task: UiBenchTask): string {
  return [buildUiSystemPrompt(task), '', '---', buildUiUserPrompt(task)].join('\n');
}
