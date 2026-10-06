/**
 * Stand-ins for customer web applications (playwright.config.ts starts it):
 * plain pages on GRANTED_SITE and UNGRANTED_SITE. `/frame` embeds a
 * same-origin iframe, so tests can check that nothing runs in subframes.
 * `/demo/` is the Edit Mode demo application (`pnpm demo:site`), and
 * `/demo/strict/` the same under a strict Content Security Policy.
 */
import { createServer } from 'node:http'

import { serveDemo } from '../scripts/demo-handler'
import { GRANTED_SITE, UNGRANTED_SITE } from './environment'

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (char) => `&#${String(char.charCodeAt(0))};`)

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><main><h1>${title}</h1>${body}</main></body></html>`
}

for (const site of [GRANTED_SITE, UNGRANTED_SITE]) {
  const { port } = new URL(site)
  createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', site).pathname
    if (pathname.startsWith('/demo/')) {
      void serveDemo(pathname.slice('/demo/'.length), request, response).then((served) => {
        if (served) return
        response.statusCode = 404
        response.end()
      })
      return
    }
    const path = escape(pathname)
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(
      path === '/frame'
        ? page(`Framed app ${port}`, '<iframe title="Inner page" src="/inner"></iframe>')
        : page(`Customer app ${port}`, `<p>Page ${path}</p>`),
    )
  }).listen(Number(port), 'localhost')
}
