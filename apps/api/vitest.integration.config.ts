import { defaultServerConditions } from 'vite'
import { defineProject } from 'vitest/config'

/**
 * Integration tests against a real PostgreSQL database (`contextlayer_test`).
 * Needs `docker compose up -d` locally; CI provides a service container.
 */
export default defineProject({
  ssr: { resolve: { conditions: ['@contextlayer/source', ...defaultServerConditions] } },
  test: {
    name: 'api-integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/support/global-setup.ts'],
    // One shared database: files must not truncate each other's data.
    fileParallelism: false,
    // argon2id hashing (19 MiB, t=2) makes auth tests slower than unit tests.
    testTimeout: 15_000,
  },
})
