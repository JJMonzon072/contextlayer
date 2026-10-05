import { defineConfig, devices } from '@playwright/test'

const isCI = Boolean(process.env.CI)

/** The end-to-end API and the dashboard preview that proxies /api to it. */
export const E2E_API_URL = 'http://localhost:3100'
export const E2E_DASHBOARD_URL = 'http://localhost:4173'

/**
 * End-to-end tests against the BUILT dashboard (`vite preview`) and the BUILT
 * API on a dedicated database (`contextlayer_e2e`, emptied at start; see
 * apps/api/scripts/e2e-server.ts), never the development one. Run `pnpm build`
 * and `docker compose up -d` first; the root `pnpm test:e2e` builds for you.
 *
 * Both servers are always started by Playwright: reusing a running dev server
 * would point the tests at the development database.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    baseURL: E2E_DASHBOARD_URL,
    // Traces record every request with its cookies; screenshots never show credentials.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @contextlayer/api e2e:server',
      url: `${E2E_API_URL}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm preview',
      url: E2E_DASHBOARD_URL,
      env: { DASHBOARD_API_PROXY_TARGET: E2E_API_URL },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
