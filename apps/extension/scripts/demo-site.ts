/**
 * `pnpm demo:site`: the Edit Mode demo application on http://127.0.0.1:4400
 * (loopback only). Register that origin as an application in a workspace,
 * turn ContextLayer on for it from the popup, and open Edit Mode there.
 * /strict/ is the same app under a strict Content Security Policy.
 *
 * It never stops other processes: if the port is taken, it says so and exits.
 * `--port <n>` picks another port (the application origin changes with it).
 */
import { createServer } from 'node:http'

import { serveDemo } from './demo-handler'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 4400

function portArgument(): number {
  const index = process.argv.indexOf('--port')
  if (index === -1) return DEFAULT_PORT
  const port = Number(process.argv[index + 1])
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('--port must be a number between 1024 and 65535')
  }
  return port
}

const port = portArgument()
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://${HOST}`).pathname.slice(1)
  serveDemo(path, request, response)
    .then((served) => {
      if (served) return
      response.statusCode = 404
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end('Not found')
    })
    .catch(() => {
      response.statusCode = 500
      response.end()
    })
})

server.on('error', (error: NodeJS.ErrnoException) => {
  process.stderr.write(
    error.code === 'EADDRINUSE'
      ? `Port ${String(port)} on ${HOST} is in use. Stop what uses it, or run with --port <another port>.\n`
      : `The demo site could not start: ${error.message}\n`,
  )
  process.exit(1)
})

server.listen(port, HOST, () => {
  const origin = `http://${HOST}:${String(port)}`
  process.stdout.write(
    [
      `Demo site: ${origin}/  (strict CSP: ${origin}/strict/)`,
      `Register the origin ${origin} as an application in the dashboard, then turn`,
      'ContextLayer on for it from the extension popup and open Edit Mode.',
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  )
})
