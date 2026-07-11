import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './ui/e2e',
  outputDir: './test-results/playwright',
  timeout: 30_000,
  workers: 1,
  reporter: 'line',
  webServer: {
    command: 'BRIDGEBENCH_RESULTS_DIR=test/fixtures/dashboard-results npm run dashboard',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4317',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
