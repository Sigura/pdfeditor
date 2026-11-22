import { defineConfig } from '@playwright/test';

// Starts the API and the Vite dev server unless they already run (e.g. in a dev session).
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:5173', viewport: { width: 1500, height: 1000 } },
  webServer: [
    { command: 'npx tsx src/main.ts', cwd: 'apps/server', port: 3001, reuseExistingServer: true },
    { command: 'npx vite', cwd: 'apps/web', port: 5173, reuseExistingServer: true },
  ],
});
