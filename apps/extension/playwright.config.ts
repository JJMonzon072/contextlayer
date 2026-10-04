import { defineConfig } from '@playwright/test'

const isCI = Boolean(process.env.CI)

/**
 * Loads the BUILT unpacked extension (`dist/`) into Chromium. Run `pnpm build`
 * and `docker compose up -d` first; the root `pnpm test:e2e` builds for you.
 * Each test launches its own persistent Chromium context (see e2e/fixtures.ts);
 * one worker keeps several browsers from running at once.
 *
 * The API must listen on :3000 because that origin is baked into the extension
 * build (EXTENSION_API_BASE_URL). Locally, an API already running there (for
 * example `pnpm dev`) is reused; on CI the built API is always started.
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
