import { defineConfig, devices } from '@playwright/test';

// T7 (docs/TESTING.md). Hors CI GitHub (quota de minutes) : à lancer en local ou
// sur le serveur dans l'image officielle Playwright (voir docs/TESTING.md).
const port = Number(process.env.E2E_PORT || 8790);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx e2e/fixture-server.ts',
    url: `http://127.0.0.1:${port}/dashboard/login.html`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(port) },
  },
});
