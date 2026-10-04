import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defaultClientConditions, loadEnv, type InlineConfig, type Plugin } from 'vite'

import { createManifest } from './manifest.config'

/**
 * The extension is produced by two Vite builds that share this file
 * (orchestrated by scripts/build.ts, see docs/adr/0009-extension-build-tooling.md):
 *
 * 1. Extension pages + service worker: popup.html and background.js, as ES modules.
 * 2. Content script: a single self-contained IIFE, because content scripts
 *    declared in the manifest are classic scripts and cannot `import` chunks.
 */

const extensionRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
export const OUT_DIR = fileURLToPath(new URL('./dist', import.meta.url))

interface BuildOptions {
  mode: 'development' | 'production'
  watch: boolean
}

interface ExtensionEnv {
  apiBaseUrl: URL
  version: string
}

function readExtensionEnv(mode: string): ExtensionEnv {
  const env = loadEnv(mode, workspaceRoot, '')
  const rawUrl = env.EXTENSION_API_BASE_URL ?? 'http://localhost:3000'
  const apiBaseUrl = new URL(rawUrl)
  if (apiBaseUrl.protocol !== 'http:' && apiBaseUrl.protocol !== 'https:') {
    throw new Error(`EXTENSION_API_BASE_URL must be an http(s) URL, got "${rawUrl}"`)
  }

  const packageJson = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { version: string }

  return { apiBaseUrl, version: packageJson.version }
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
      __CONTEXTLAYER_VERSION__: JSON.stringify(env.version),
    },
    build: {
      outDir: OUT_DIR,
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
      const manifest = createManifest({ version: env.version, apiBaseUrl: env.apiBaseUrl })
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      })
    },
  }
}

export function createPagesConfig(options: BuildOptions): InlineConfig {
  const env = readExtensionEnv(options.mode)
  const base = baseConfig(options, env)

  return {
    ...base,
    plugins: [vue(), tailwindcss(), manifestPlugin(env)],
    build: {
      ...base.build,
      rolldownOptions: {
        input: {
          popup: fileURLToPath(new URL('./popup.html', import.meta.url)),
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
  const env = readExtensionEnv(options.mode)
  const base = baseConfig(options, env)

  return {
    ...base,
    publicDir: false,
    define: {
      ...base.define,
      // Library mode does not replace this, and Vue reads it at runtime.
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
