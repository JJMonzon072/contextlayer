import { defineConfig } from 'vitest/config'

/**
 * `pnpm test` at the root runs every package's unit tests in one Vitest
 * process. Each project keeps its own config (environment, plugins, aliases).
 */
export default defineConfig({
  test: {
    projects: ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
  },
})
