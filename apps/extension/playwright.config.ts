import { defineConfig } from '@playwright/test'

import { E2E_API_URL, E2E_DASHBOARD_URL, GRANTED_SITE } from './e2e/environment'

const isCI = Boolean(process.env.CI)

/**
 * Loads the e2e build of the extension (`dist-e2e/`, built by `pnpm test:e2e`)
 * into Chromium, against:
 * - the BUILT API on its own database (`contextlayer_e2e`, emptied at start),
 *   never the development one;
 * - the BUILT dashboard (`vite preview`), whose /api proxy points at that API;
 * - two stand-in customer sites (e2e/site-server.ts).
 * Every server is started here; none is reused, so a running `pnpm dev` is
 * never touched. Each test launches its own persistent Chromium context (see
 * e2e/fixtures.ts); one worker keeps several browsers from running at once.
 *
 * No traces: they would record requests with their credentials.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  use: { trace: 'off' },
  webServer: [
    {
      command: 'pnpm --filter @contextlayer/api e2e:server',
      url: `${E2E_API_URL}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @contextlayer/dashboard preview',
      url: E2E_DASHBOARD_URL,
      env: { DASHBOARD_API_PROXY_TARGET: E2E_API_URL },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'tsx e2e/site-server.ts',
      url: GRANTED_SITE,
      reuseExistingServer: false,
      timeout: 15_000,
    },
  ],
})
