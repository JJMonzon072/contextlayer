import { createHash } from 'node:crypto'

import {
  DEVELOPMENT_EXTENSION_PUBLIC_KEY,
  extensionIdFromDigestHex,
  isExtensionId,
} from '@contextlayer/shared'

/**
 * Typed source of `dist/manifest.json`. Evaluated at build time by vite.config.ts.
 *
 * Permission policy (see docs/adr/0007-chrome-manifest-v3-extension.md):
 * - `storage`: credentials live in chrome.storage (session, and local once it
 *   is restricted to trusted contexts; see docs/adr/0015-authentication-strategy.md).
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
  /** The dashboard that hands over connection codes; only its exact origin may message us. */
  dashboardUrl: URL
  identity: ExtensionIdentity
  /**
   * End-to-end build only: customer sites granted at install time, because
   * Chrome's permission prompt cannot be answered under automation.
   */
  preGrantedSites?: URL[]
}

/**
 * Pages where the Phase 1 content script runs: the local dashboard (Vite dev and
 * preview). Ports are explicit because a pattern without a port matches all ports.
 */
export const CONTENT_SCRIPT_MATCHES = ['http://localhost:5173/*', 'http://localhost:4173/*']

export function createManifest({
  version,
  apiBaseUrl,
  dashboardUrl,
  identity,
  preGrantedSites = [],
}: ManifestOptions): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'ContextLayer',
    // Public key that fixes the extension id (see packages/shared/src/extension-identity.ts).
    key: identity.publicKey,
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
    permissions: ['storage'],
    content_scripts: [
      {
        matches: CONTENT_SCRIPT_MATCHES,
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
    // A pattern without a port matches every port, so the port is always
    // explicit, including the scheme default that `URL.origin` would omit.
    host_permissions: [originPattern(apiBaseUrl), ...preGrantedSites.map(originPattern)],
    // The dashboard page and nothing else may message the extension: no other
    // site and, since "ids" is absent, no other extension (verified in the spike).
    externally_connectable: { matches: [originPattern(dashboardUrl)] },
  }
}

/** `https://api.example.com` → `https://api.example.com:443/*` (port pinned). */
export function originPattern(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.protocol}//${url.hostname}:${port}/*`
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Validates an origin baked into the build (`EXTENSION_API_BASE_URL`). Only an
 * origin is accepted: a path, query, fragment or credentials would otherwise
 * be dropped silently. Plain http is only allowed for loopback development
 * hosts; any remote service must use https.
 */
export function parseServiceOrigin(name: string, raw: string | undefined, fallback: string): URL {
  const value = raw?.trim() ? raw.trim() : fallback
  const url = URL.canParse(value) ? new URL(value) : undefined
  const valid =
    url !== undefined &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !value.includes('#') &&
    !value.includes('?')
  if (!valid) {
    throw new Error(
      `${name} must be an https origin such as https://api.example.com (http only for localhost), got "${value}"`,
    )
  }
  return url
}

export function parseApiBaseUrl(raw: string | undefined): URL {
  return parseServiceOrigin('EXTENSION_API_BASE_URL', raw, 'http://localhost:3000')
}

export function parseDashboardUrl(raw: string | undefined): URL {
  return parseServiceOrigin('EXTENSION_DASHBOARD_URL', raw, 'http://localhost:5173')
}

export interface ExtensionIdentity {
  /** Base64 DER public key, the manifest `key`. */
  publicKey: string
  /** The id Chrome derives from it. */
  id: string
}

/**
 * The manifest key and the id it produces. Without EXTENSION_PUBLIC_KEY the
 * committed development key is used, so every build of a clone gets the same
 * id. When EXTENSION_ID is also set, it must be the id of that key: the
 * dashboard and the API are configured with the id, the manifest with the key.
 */
export function resolveExtensionIdentity(env: {
  EXTENSION_PUBLIC_KEY?: string | undefined
  EXTENSION_ID?: string | undefined
}): ExtensionIdentity {
  const publicKey = env.EXTENSION_PUBLIC_KEY?.trim()
    ? env.EXTENSION_PUBLIC_KEY.trim()
    : DEVELOPMENT_EXTENSION_PUBLIC_KEY
  const der = Buffer.from(publicKey, 'base64')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey) || der.length < 64) {
    throw new Error('EXTENSION_PUBLIC_KEY must be a base64 DER public key (no PEM header).')
  }
  const id = extensionIdFromDigestHex(createHash('sha256').update(der).digest('hex'))
  const expected = env.EXTENSION_ID?.trim()
  if (expected && (!isExtensionId(expected) || expected !== id)) {
    throw new Error(
      `EXTENSION_ID (${expected}) does not match the id of EXTENSION_PUBLIC_KEY (${id}).`,
    )
  }
  return { publicKey, id }
}
