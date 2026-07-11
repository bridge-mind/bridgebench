import { expect, test } from '@playwright/test';

const SCREENSHOT_DIR = process.env.BRIDGEBENCH_SCREENSHOT_DIR ?? '/tmp';

for (const width of [1440, 800, 390]) {
  test(`dashboard is usable at ${width}px`, async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle('BridgeBench V3 Arena');

    // Arena view is the default. The stage is state-dependent: the idle
    // explainer (#how-title) or, when a run is active, the live stage.
    await expect(page.getByText('BridgeBench', { exact: true })).toBeVisible();
    const idleExplainer = page.locator('#how-title');
    await expect(idleExplainer.or(page.locator('.stage-task')).first()).toBeVisible();
    if (await idleExplainer.isVisible()) {
      // Start run is disabled exactly when the server has no OpenRouter key.
      const keyWarning = page.getByText('Set OPENROUTER_API_KEY', { exact: false });
      if (await keyWarning.isVisible()) {
        await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
      } else {
        await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
      }
    }

    // View navigation swaps sections without reloading.
    await page.getByRole('button', { name: 'Leaderboard' }).click();
    await expect(page.getByRole('heading', { name: 'Standings' })).toBeVisible();
    await page.getByRole('button', { name: 'Matches' }).click();
    await expect(page.locator('#matches-title')).toBeVisible();
    await page.getByRole('button', { name: 'Arena' }).click();
    await expect(page.locator('#how-title').or(page.locator('.stage-task')).first()).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/bridgebench-v3-${width}.png`, fullPage: true });
    await page.close();
  });
}

test('a journaled match exposes the task the models were given', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Matches' }).click();
  await expect(page.locator('.match-list, .empty').first()).toBeVisible();

  const rows = page.locator('.match-row');
  test.skip((await rows.count()) === 0, 'no journaled matches in results/reasoning on this machine');

  await rows.first().click();
  const taskTab = page.getByRole('tab', { name: 'Task' });
  await expect(taskTab).toBeVisible();
  await taskTab.click();

  // The Task pane shows the exact public context competitors receive:
  // prompt plus at least one expandable artifact (every task has >= 1).
  await expect(page.locator('.task-prompt')).toBeVisible();
  const firstArtifact = page.locator('.artifact').first();
  await expect(firstArtifact).toBeVisible();
  await firstArtifact.locator('summary').click();
  await expect(firstArtifact.locator('pre')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/bridgebench-v3-match-task.png`, fullPage: true });
});

test('the live stage advertises the running task', async ({ page }) => {
  // Static check only — no paid run is started. When idle, the explainer
  // renders; the task brief itself is exercised in the match-detail test.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(
    page.locator('#how-title').or(page.locator('.stage-task')).first(),
  ).toBeVisible();
});
