import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defaultClientConditions, defineConfig, loadEnv, type ProxyOptions } from 'vite'

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

function readProxyTarget(value: string | undefined): string {
  // An empty value (e.g. `DASHBOARD_API_PROXY_TARGET=`) means "use the default".
  const target = value?.trim() ? value.trim() : 'http://localhost:3000'
  const url = URL.canParse(target) ? new URL(target) : undefined
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    throw new Error(`DASHBOARD_API_PROXY_TARGET must be an http(s) URL, got "${target}"`)
  }
  return target
}

export default defineConfig(({ mode }) => {
  // The monorepo keeps a single `.env` at its root.
  const env = loadEnv(mode, workspaceRoot, '')

  // Same-origin model: the browser only ever talks to the dashboard origin and
  // `/api/*` is forwarded to the API. In production a reverse proxy does this,
  // which keeps future session cookies first-party and removes the need for CORS.
  // The key is a regex so that dashboard routes such as `/api-keys` are not proxied.
  const proxy: Record<string, ProxyOptions> = {
    '^/api(?:/|$)': {
      target: readProxyTarget(env.DASHBOARD_API_PROXY_TARGET),
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api(?=\/|$)/, ''),
    },
  }

  return {
    plugins: [vue(), tailwindcss()],
    envDir: workspaceRoot,
    resolve: {
      // Consume workspace packages from source (see docs/adr/0011-source-first-workspace-packages.md).
      conditions: ['@contextlayer/source', ...defaultClientConditions],
    },
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
  }
})
