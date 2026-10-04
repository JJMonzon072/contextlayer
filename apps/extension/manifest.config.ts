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
    // A pattern without a port matches every port, so the API origin is used
    // as-is (scheme + host + port): the narrowest grant that still works.
    host_permissions: [`${apiBaseUrl.origin}/*`],
  }
}
