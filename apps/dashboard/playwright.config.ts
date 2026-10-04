import { defineConfig, devices } from '@playwright/test'

const isCI = Boolean(process.env.CI)

/**
 * End-to-end tests against the BUILT dashboard (`vite preview`) and the BUILT
 * API (`node dist/server.js`). Run `pnpm build` and `docker compose up -d` first;
 * the root `pnpm test:e2e` script does the build for you.
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
