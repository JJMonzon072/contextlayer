import type { FastifyReply, FastifyRequest } from 'fastify'

import type { AuthContext, AuthService } from './auth.service.js'
import { clearedSessionCookieOptions } from './session-cookie.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireSession`; null on routes that do not require it. */
    auth: AuthContext | null
  }
}

class UnauthorizedError extends Error {
  readonly statusCode = 401
}

/**
 * preHandler for every cookie-authenticated route. An unknown, revoked or
 * expired session clears the cookie and answers 401.
 */
export function createRequireSession(auth: AuthService, cookieName: string) {
  return async function requireSession(request: FastifyRequest, reply: FastifyReply) {
    // A bearer request authenticates by its token alone and cookies are ignored
    // (ADR 0015). Bearer tokens arrive in Phase 4; until then they are rejected.
    if (request.headers.authorization?.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedError('Authentication required')
    }
    const token = request.cookies[cookieName]
    const context = token === undefined ? undefined : await auth.authenticate(token)
    if (!context) {
      if (token !== undefined) void reply.clearCookie(cookieName, clearedSessionCookieOptions())
      throw new UnauthorizedError('Authentication required')
    }
    request.auth = context
  }
}

/** The authenticated context of a route that runs behind `requireSession`. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new UnauthorizedError('Authentication required')
  return request.auth
}
