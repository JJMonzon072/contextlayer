import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

/**
 * Serves the Edit Mode demo application (apps/extension/demo/) and nothing
 * else: a fixed list of files, read from that folder, never a path taken from
 * the request. `strict/` serves the same pages under a strict Content
 * Security Policy with Trusted Types, to check that ContextLayer's injected
 * UI works without relaxing a page's policy. `flow/` is a small single-page
 * application whose routes (`flow/`, `flow/customers/new`) all serve the same
 * page, so a reload or a link lands on any of them (Phase 6b). Used by
 * `pnpm demo:site` and by the end-to-end tests.
 */

const DEMO_DIR = fileURLToPath(new URL('../demo/', import.meta.url))

const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript; charset=utf-8'
const CSS = 'text/css; charset=utf-8'

/**
 * `cacheable`: served without `no-store`, which would keep the page out of
 * Chrome's back/forward cache (the flow pages exercise it).
 */
const FILES: Record<string, { file: string; type: string; cacheable?: boolean }> = {
  '': { file: 'index.html', type: HTML },
  'index.html': { file: 'index.html', type: HTML },
  'reports.html': { file: 'reports.html', type: HTML },
  'demo.js': { file: 'demo.js', type: JS },
  'demo.css': { file: 'demo.css', type: CSS },
  'flow/': { file: 'flow.html', type: HTML, cacheable: true },
  'flow/index.html': { file: 'flow.html', type: HTML, cacheable: true },
  'flow/customers/new': { file: 'flow.html', type: HTML, cacheable: true },
  'flow/flow.js': { file: 'flow.js', type: JS, cacheable: true },
  'flow/customers/flow.js': { file: 'flow.js', type: JS, cacheable: true },
  'flow/demo.css': { file: 'demo.css', type: CSS, cacheable: true },
  'flow/customers/demo.css': { file: 'demo.css', type: CSS, cacheable: true },
}

export const STRICT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ')

/**
 * Handles `path` (relative to where the demo is mounted, without a leading
 * slash). Returns false when it is not a demo path, so a caller can serve
 * something else.
 */
export async function serveDemo(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const strict = path === 'strict' || path.startsWith('strict/')
  const name = strict ? path.slice('strict/'.length) : path
  const entry = FILES[name]
  if (!entry || (request.method !== 'GET' && request.method !== 'HEAD')) return false
  const body = await readFile(`${DEMO_DIR}${entry.file}`)
  response.setHeader('content-type', entry.type)
  response.setHeader('cache-control', entry.cacheable ? 'no-cache' : 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  if (strict) response.setHeader('content-security-policy', STRICT_CSP)
  response.end(request.method === 'HEAD' ? undefined : body)
  return true
}
