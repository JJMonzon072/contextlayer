import { defineConfig, devices } from '@playwright/test'

const isCI = Boolean(process.env.CI)

/**
 * End-to-end tests against the BUILT dashboard (`vite preview`) and the API.
 * Run `pnpm build` and `docker compose up -d` first; the root `pnpm test:e2e`
 * script does the build for you.
 *
 * Servers already listening locally are reused (on CI they are always started
 * from the build): if `pnpm dev` is running, the tests talk to the dev API on
 * :3000. The API port is fixed at 3000 for e2e because the preview proxy and
 * the extension build point there (see .env.example).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @contextlayer/api start',
      url: 'http://localhost:3000/health/live',
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
    {
      command: 'pnpm preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
  ],
})
