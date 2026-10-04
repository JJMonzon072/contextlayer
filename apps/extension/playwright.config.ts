import { defineConfig } from '@playwright/test'

const isCI = Boolean(process.env.CI)

/**
 * Loads the BUILT unpacked extension (`dist/`) into Chromium. Run `pnpm build`
 * and `docker compose up -d` first; the root `pnpm test:e2e` builds for you.
 * Extensions need a persistent context, so tests share a worker-scoped browser
 * (see e2e/fixtures.ts) and run serially.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm --filter @contextlayer/api start',
    url: 'http://localhost:3000/health/live',
    reuseExistingServer: !isCI,
    timeout: 30_000,
  },
})
