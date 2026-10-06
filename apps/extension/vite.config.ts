import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defaultClientConditions, loadEnv, type InlineConfig, type Plugin } from 'vite'

import { E2E_API_URL, E2E_DASHBOARD_URL, E2E_OUT_DIR, GRANTED_SITE } from './e2e/environment'
import {
  createManifest,
  parseApiBaseUrl,
  parseDashboardUrl,
  resolveExtensionIdentity,
  type ExtensionIdentity,
} from './manifest.config'

/**
 * The extension is produced by two Vite builds that share this file
 * (orchestrated by scripts/build.ts, see docs/adr/0009-extension-build-tooling.md):
 *
 * 1. Extension pages + service worker: popup.html, sidepanel.html and background.js,
 *    as ES modules.
 * 2. Content script: a single self-contained IIFE, because content scripts
 *    declared in the manifest are classic scripts and cannot `import` chunks.
 */

const extensionRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
export const OUT_DIR = fileURLToPath(new URL('./dist', import.meta.url))

interface BuildOptions {
  mode: 'development' | 'production'
  watch: boolean
  /** The end-to-end variant: e2e servers, a pre-granted test site, dist-e2e/. */
  e2e?: boolean
}

interface ExtensionEnv {
  apiBaseUrl: URL
  dashboardUrl: URL
  identity: ExtensionIdentity
  version: string
  outDir: string
  preGrantedSites: URL[]
}

function readExtensionEnv({ mode, e2e = false }: BuildOptions): ExtensionEnv {
  const packageJson = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { version: string }

  if (e2e) {
    // Fixed values, independent of the developer's .env.
    return {
      apiBaseUrl: parseApiBaseUrl(E2E_API_URL),
      dashboardUrl: parseDashboardUrl(E2E_DASHBOARD_URL),
      identity: resolveExtensionIdentity({}),
      version: packageJson.version,
      outDir: E2E_OUT_DIR,
      preGrantedSites: [new URL(GRANTED_SITE)],
    }
  }

  const env = loadEnv(mode, workspaceRoot, '')
  return {
    apiBaseUrl: parseApiBaseUrl(env.EXTENSION_API_BASE_URL),
    dashboardUrl: parseDashboardUrl(env.EXTENSION_DASHBOARD_URL),
    identity: resolveExtensionIdentity(env),
    version: packageJson.version,
    outDir: OUT_DIR,
    preGrantedSites: [],
  }
}

/** Shared by both builds: source-first workspace packages and build-time constants. */
function baseConfig({ mode, watch }: BuildOptions, env: ExtensionEnv): InlineConfig {
  return {
    configFile: false,
    root: extensionRoot,
    mode,
    logLevel: 'info',
    resolve: { conditions: ['@contextlayer/source', ...defaultClientConditions] },
    define: {
      __CONTEXTLAYER_API_BASE_URL__: JSON.stringify(env.apiBaseUrl.origin),
      __CONTEXTLAYER_DASHBOARD_ORIGIN__: JSON.stringify(env.dashboardUrl.origin),
      __CONTEXTLAYER_VERSION__: JSON.stringify(env.version),
    },
    build: {
      outDir: env.outDir,
      // scripts/build.ts cleans dist once; the two builds must not wipe each other.
      emptyOutDir: false,
      sourcemap: mode === 'development' ? 'inline' : false,
      minify: mode === 'production',
      watch: watch ? {} : null,
    },
  }
}

function manifestPlugin(env: ExtensionEnv): Plugin {
  return {
    name: 'contextlayer:manifest',
    generateBundle() {
      const manifest = createManifest({
        version: env.version,
        apiBaseUrl: env.apiBaseUrl,
        dashboardUrl: env.dashboardUrl,
        identity: env.identity,
        preGrantedSites: env.preGrantedSites,
      })
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      })
    },
  }
}

export function createPagesConfig(options: BuildOptions): InlineConfig {
  const env = readExtensionEnv(options)
  const base = baseConfig(options, env)

  return {
    ...base,
    plugins: [vue(), tailwindcss(), manifestPlugin(env)],
    build: {
      ...base.build,
      rolldownOptions: {
        input: {
          popup: fileURLToPath(new URL('./popup.html', import.meta.url)),
          sidepanel: fileURLToPath(new URL('./sidepanel.html', import.meta.url)),
          background: fileURLToPath(new URL('./src/background/index.ts', import.meta.url)),
        },
        output: {
          // The manifest references the service worker by a stable name.
          entryFileNames: (chunk) =>
            chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        },
      },
    },
  }
}

export function createContentScriptConfig(options: BuildOptions): InlineConfig {
  const env = readExtensionEnv(options)
  const base = baseConfig(options, env)

  return {
    ...base,
    publicDir: false,
    define: {
      ...base.define,
      // Defensive: library mode does not replace this. The Phase 1 content script
      // does not read it, but any dependency that does (Vue, once the guide player
      // mounts components in the page) would throw "process is not defined".
      'process.env.NODE_ENV': JSON.stringify(options.mode),
    },
    build: {
      ...base.build,
      lib: {
        entry: fileURLToPath(new URL('./src/content/index.ts', import.meta.url)),
        formats: ['iife'],
        name: 'ContextLayerContentScript',
        fileName: () => 'content.js',
      },
    },
  }
}
