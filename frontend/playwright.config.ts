import { defineConfig } from '@playwright/test';
import { requireDisposableTestDbUrl } from '../src/__tests__/test-db-url.js';

// Never attach smoke tests to the operator's normal dashboard on 6601: its DB
// may not be the disposable fixture DB the test process prepared.
const port = process.env.MAI_E2E_PORT ?? '16601';
const baseURL = `http://127.0.0.1:${port}`;
const dbUrl = requireDisposableTestDbUrl();

// Smoke suite runs against the BUILT app served by the mai-brain-web server
// (from ../build/web-server.js → serves frontend/dist). Run `npm run build:web`
// and the root `npm run build` before `npx playwright test`.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node build/web-server.js',
    cwd: '..',
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MAI_PROJECT_SLUG: 'e2e-dash',
      MAI_BRAIN_WEB_PORT: port,
      MAI_DB_URL: dbUrl,
    },
  },
});
