/**
 * Typed source of `dist/manifest.json`. Evaluated at build time by vite.config.ts.
 *
 * Permission policy (see docs/adr/0007-chrome-manifest-v3-extension.md):
 * - No `permissions` yet: Phase 1 needs none of the privileged APIs.
 * - `host_permissions` only covers the ContextLayer API origin, so the service
 *   worker can call it without CORS.
 * - Content-script match patterns ALSO grant host access, so they are pinned to
 *   exact origins too: in Phase 1 the content script only runs on the local
 *   dashboard (dev and preview servers), the one page every developer has.
 *   Customer domains will be granted at runtime (optional host permissions +
 *   `chrome.scripting.registerContentScripts`) in Phase 4.
 */
interface ManifestOptions {
  version: string
  apiBaseUrl: URL
}

/**
 * Pages where the Phase 1 content script runs: the local dashboard (Vite dev and
 * preview). Ports are explicit because a pattern without a port matches all ports.
 */
export const CONTENT_SCRIPT_MATCHES = ['http://localhost:5173/*', 'http://localhost:4173/*']

export function createManifest({
  version,
  apiBaseUrl,
}: ManifestOptions): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'ContextLayer',
    description: 'Interactive, in-app guides for the web applications your team already uses.',
    version,
    minimum_chrome_version: '120',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'ContextLayer',
      default_popup: 'popup.html',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: [
      {
        matches: CONTENT_SCRIPT_MATCHES,
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
    // A pattern without a port matches every port, so the port is always
    // explicit, including the scheme default that `URL.origin` would omit.
    host_permissions: [originPattern(apiBaseUrl)],
  }
}

/** `https://api.example.com` → `https://api.example.com:443/*` (port pinned). */
export function originPattern(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.protocol}//${url.hostname}:${port}/*`
}

/**
 * Validates `EXTENSION_API_BASE_URL`. Only an origin is accepted: the API serves
 * its routes at the root and only the origin is baked into the build, so a
 * path, query or fragment would otherwise be dropped silently.
 */
export function parseApiBaseUrl(raw: string | undefined): URL {
  const value = raw?.trim() ? raw.trim() : 'http://localhost:3000'
  const url = URL.canParse(value) ? new URL(value) : undefined
  if (
    url === undefined ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `EXTENSION_API_BASE_URL must be an http(s) origin such as https://api.example.com, got "${value}"`,
    )
  }
  return url
}
