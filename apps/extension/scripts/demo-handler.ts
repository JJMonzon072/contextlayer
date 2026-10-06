import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

/**
 * Serves the Edit Mode demo application (apps/extension/demo/) and nothing
 * else: a fixed list of files, read from that folder, never a path taken from
 * the request. `strict/` serves the same pages under a strict Content
 * Security Policy with Trusted Types, to check that ContextLayer's injected
 * UI works without relaxing a page's policy. Used by `pnpm demo:site` and by
 * the end-to-end tests.
 */

const DEMO_DIR = fileURLToPath(new URL('../demo/', import.meta.url))

const FILES: Record<string, { file: string; type: string }> = {
  '': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'reports.html': { file: 'reports.html', type: 'text/html; charset=utf-8' },
  'demo.js': { file: 'demo.js', type: 'text/javascript; charset=utf-8' },
  'demo.css': { file: 'demo.css', type: 'text/css; charset=utf-8' },
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
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  if (strict) response.setHeader('content-security-policy', STRICT_CSP)
  response.end(request.method === 'HEAD' ? undefined : body)
  return true
}
