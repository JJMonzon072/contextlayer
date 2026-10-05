import { defaultServerConditions } from 'vite'
import { defineProject } from 'vitest/config'

export default defineProject({
  // Node test files go through Vite's SSR resolver, so the custom condition
  // belongs in `ssr.resolve.conditions`, and Vite's defaults must be kept.
  // Workspace packages then resolve from source: tests never need a prior build.
  ssr: { resolve: { conditions: ['@contextlayer/source', ...defaultServerConditions] } },
  test: {
    name: 'api',
    environment: 'node',
    // Unit tests only; test/integration runs in its own project (vitest.integration.config.ts).
    include: ['test/*.test.ts'],
  },
})
