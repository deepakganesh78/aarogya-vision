import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 8181;
const dataDir = path.join(os.tmpdir(), `av-e2e-${Date.now()}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    browserName: 'chromium',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }
  },
  webServer: {
    command: 'node src/server.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    // Auto sign-in off: these tests exercise the access-code screens.
    env: { PORT: String(PORT), AI_PROVIDER: 'mock', DATA_DIR: dataDir, SESSION_SECRET: 'e2e-secret', AUTO_LOGIN: 'false' }
  }
});
