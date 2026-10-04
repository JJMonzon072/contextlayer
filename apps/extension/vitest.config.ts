import vue from '@vitejs/plugin-vue'
import { defaultClientConditions } from 'vite'
import { defineProject } from 'vitest/config'

export default defineProject({
  plugins: [vue()],
  resolve: { conditions: ['@contextlayer/source', ...defaultClientConditions] },
  define: {
    __CONTEXTLAYER_API_BASE_URL__: JSON.stringify('http://api.test'),
    __CONTEXTLAYER_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    name: 'extension',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
})
