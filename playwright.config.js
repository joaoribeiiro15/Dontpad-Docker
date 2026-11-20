// End-to-end tests.
//
// By default this starts a local server with a temporary database. To run
// against the container instead: BASE_URL=http://localhost:3000 npx playwright test

import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const external = Boolean(process.env.BASE_URL);
const port = Number(process.env.E2E_PORT || 3999);
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${port}`;
const syncIntervalMs = Number(process.env.SYNC_INTERVAL_MS || (external ? 5000 : 1000));
process.env.SYNC_INTERVAL_MS = String(syncIntervalMs);

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.js',
  timeout: 30_000 + syncIntervalMs * 6,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : {
        command: 'node src/server.js',
        url: `${baseURL}/healthz`,
        reuseExistingServer: false,
        timeout: 30_000,
        env: {
          PORT: String(port),
          HOST: '127.0.0.1',
          DB_PATH: path.join(os.tmpdir(), `openpad-e2e-${Date.now()}.db`),
          SYNC_INTERVAL_MS: String(syncIntervalMs),
          RATE_LIMIT_PER_MIN: '100000',
          // The first-run setup has its own test with its own server.
          PUBLIC_ADDRESS: 'pad.example.test',
          LOG_LEVEL: 'warn',
        },
      },
});
