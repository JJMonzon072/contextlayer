import vue from '@vitejs/plugin-vue'
import { defaultClientConditions } from 'vite'
import { defineProject } from 'vitest/config'

export default defineProject({
  plugins: [vue()],
  // Tests talk to a fake extension with the development id.
  define: { __CONTEXTLAYER_EXTENSION_ID__: JSON.stringify('') },
  resolve: { conditions: ['@contextlayer/source', ...defaultClientConditions] },
  test: {
    name: 'dashboard',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
})
