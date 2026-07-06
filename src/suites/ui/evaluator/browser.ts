/**
 * Chromium launch for artifact evaluation.
 *
 * WebGL runs on SwiftShader (CPU rasterization) so official runs are
 * pixel-reproducible across machines for a pinned Chromium:
 *   --use-angle=swiftshader        route ANGLE through SwiftShader
 *   --enable-unsafe-swiftshader    required on Chrome ≥132, where software
 *                                  WebGL fallback is otherwise blocked
 * Never pass --disable-gpu: it disables WebGL entirely in new headless.
 *
 * Official runs use the pinned Docker image (docker/Dockerfile.eval) with
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH set; local dev falls back to system
 * Chrome/Chromium.
 */

import { existsSync } from 'node:fs';

import { chromium, type Browser } from 'playwright-core';

const LAUNCH_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--force-color-profile=srgb',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--disable-lcd-text',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--js-flags=--random-seed=42',
];

const SYSTEM_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

export function resolveChromiumExecutablePath(): string {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points at a missing file: ${fromEnv}`,
      );
    }
    return fromEnv;
  }

  for (const candidate of SYSTEM_CHROME_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'No Chromium executable found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ' +
      '(official runs use docker/Dockerfile.eval) or install Google Chrome.',
  );
}

export async function launchEvalBrowser(): Promise<{
  browser: Browser;
  executablePath: string;
}> {
  const executablePath = resolveChromiumExecutablePath();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: LAUNCH_ARGS,
  });
  return { browser, executablePath };
}
