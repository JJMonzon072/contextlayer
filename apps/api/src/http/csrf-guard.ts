import type { FastifyInstance } from 'fastify'

import { errorBody } from './error-handler.js'

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `false` only for routes that never read cookies and authenticate with a
     * credential in the request itself (POST /v1/extension/token): a forged
     * cross-site request carries nothing the attacker does not already know.
     */
    csrf?: boolean
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface CsrfRequest {
  method: string
  origin: string | undefined
  secFetchSite: string | undefined
  authorization: string | undefined
}

/**
 * Cross-site request check for cookie-authenticated, state-changing requests
 * (ADR 0015). Order matters:
 * 1. Safe methods never change state.
 * 2. Bearer requests (the extension, Phase 4) do not use cookies, so a forged
 *    cross-site request gains nothing; cookies are ignored for them.
 * 3. A present `Origin` must be in the dashboard allow-list. `null` (opaque
 *    origins) is never in it. Origin is NOT compared with Host: the dev proxy
 *    rewrites Host but not Origin.
 * 4. Without Origin, only `Sec-Fetch-Site: same-origin` passes.
 * 5. Neither header: not a browser (curl, server-to-server), allowed; a valid
 *    session is still required by the route itself.
 */
export function isCrossSiteRequest(
  request: CsrfRequest,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (SAFE_METHODS.has(request.method)) return false
  if (request.authorization?.toLowerCase().startsWith('bearer ')) return false
  if (request.origin !== undefined) return !allowedOrigins.has(request.origin)
  if (request.secFetchSite !== undefined) return request.secFetchSite !== 'same-origin'
  return false
}

export function registerCsrfGuard(app: FastifyInstance, dashboardOrigins: readonly string[]): void {
  const allowed = new Set(dashboardOrigins)

  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config.csrf === false) return
    const crossSite = isCrossSiteRequest(
      {
        method: request.method,
        origin: request.headers.origin,
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        authorization: request.headers.authorization,
      },
      allowed,
    )
    if (crossSite) {
      request.log.warn({ origin: request.headers.origin }, 'cross-site request rejected')
      return reply
        .code(403)
        .send(errorBody('FORBIDDEN', 'Cross-site request rejected.', request.id))
    }
  })
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
