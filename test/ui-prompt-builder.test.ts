import { describe, expect, it } from 'vitest';

import { buildUiSystemPrompt, buildUiUserPrompt } from '../src/suites/ui/prompt-builder.js';
import { UiTaskLoader } from '../src/suites/ui/task-loader.js';
import type { UiBenchTask } from '../src/suites/ui/types.js';

function task(overrides: Partial<UiBenchTask> = {}): UiBenchTask {
  return {
    id: 's1-lava-lamp-redux',
    season: 1,
    title: 'Lava Lamp Redux',
    category: 'simulation',
    requiresWebGL: true,
    viewport: { width: 1280, height: 800 },
    libraries: { three: '0.182.0' },
    controls: [],
    screenshots: [{ at: 0, name: 'hero' }],
    prompt: 'Build the requested scene.',
    ...overrides,
  };
}

describe('UI prompt builder', () => {
  it('loads the Lava Lamp art direction into the system message', async () => {
    const lavaLamp = await new UiTaskLoader().loadById('s1-lava-lamp-redux');
    const system = buildUiSystemPrompt(lavaLamp);

    expect(system).toContain("BridgeBench's signature hero artifact");
    expect(system).toContain('physical lava lamp');
  });

  it('elevates task-specific art direction into the system message', () => {
    const system = buildUiSystemPrompt(
      task({ systemPrompt: 'Make the lamp unmistakably physical and product-shot ready.' }),
    );

    expect(system).toContain('TASK-SPECIFIC SYSTEM DIRECTION:');
    expect(system).toContain('Make the lamp unmistakably physical and product-shot ready.');
    expect(system.indexOf('TASK-SPECIFIC SYSTEM DIRECTION:')).toBeLessThan(
      system.indexOf('RULES:'),
    );
  });

  it('keeps the task brief in the user message', () => {
    expect(buildUiUserPrompt(task())).toBe(
      'Task ID: s1-lava-lamp-redux\nTask title: Lava Lamp Redux\n\nBuild the requested scene.',
    );
  });
});
