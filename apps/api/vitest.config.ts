import { defineProject } from 'vitest/config'

const sourceConditions = ['@contextlayer/source']

export default defineProject({
  // Resolve workspace packages from source so tests never depend on a prior build.
  resolve: { conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    name: 'api',
    environment: 'node',
  },
})
