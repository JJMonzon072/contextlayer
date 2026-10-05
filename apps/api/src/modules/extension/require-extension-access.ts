import type { FastifyReply, FastifyRequest } from 'fastify'

import type { ExtensionAuth, ExtensionService } from './extension.service.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireExtensionAccess`; null on other routes. */
    extensionAuth: ExtensionAuth | null
  }
}

class UnauthorizedError extends Error {
  readonly statusCode = 401
}

const BEARER = /^Bearer ([^\s]+)$/

/**
 * preHandler for extension routes: `Authorization: Bearer <access token>` and
 * nothing else. Cookies are never read here, so a dashboard session cannot
 * stand in for a missing or invalid token (ADR 0015).
 */
export function createRequireExtensionAccess(extension: ExtensionService) {
  return async function requireExtensionAccess(request: FastifyRequest, reply: FastifyReply) {
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1]
    const auth = token === undefined ? undefined : await extension.authenticate(token)
    if (!auth) {
      void reply.header(
        'www-authenticate',
        token === undefined
          ? 'Bearer realm="contextlayer-extension"'
          : 'Bearer realm="contextlayer-extension", error="invalid_token"',
      )
      throw new UnauthorizedError('Authentication required')
    }
    request.extensionAuth = auth
  }
}

export function extensionAuthOf(request: FastifyRequest): ExtensionAuth {
  if (!request.extensionAuth) throw new UnauthorizedError('Authentication required')
  return request.extensionAuth
}
