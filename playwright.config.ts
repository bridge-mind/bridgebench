import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './ui/e2e',
  timeout: 30_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.BRIDGEBENCH_DASHBOARD_URL ?? 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
  },
});
