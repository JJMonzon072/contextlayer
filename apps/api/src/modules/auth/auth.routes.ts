import {
  apiErrorSchema,
  AUTH_PATHS,
  loginRequestSchema,
  registerRequestSchema,
  sessionResponseSchema,
} from '@contextlayer/shared'
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import type { SessionConfig } from '../../config/env.js'
import { errorBody } from '../../http/error-handler.js'
import type { AuthService, ClientMeta } from './auth.service.js'
import { authOf } from './require-session.js'
import { clearedSessionCookieOptions, sessionCookieOptions } from './session-cookie.js'

interface AuthRoutesOptions {
  auth: AuthService
  session: SessionConfig
  requireSession: preHandlerAsyncHookHandler
}

function clientMeta(request: FastifyRequest): ClientMeta {
  return { userAgent: request.headers['user-agent'], ip: request.ip }
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = (app, options) => {
  const { auth, session, requireSession } = options

  /** A fresh token on every sign-in; a session the client already had is revoked (no fixation). */
  async function issueSession(request: FastifyRequest, reply: FastifyReply, token: string) {
    const previous = request.cookies[session.cookieName]
    if (previous !== undefined) await auth.revokeToken(previous)
    void reply.setCookie(session.cookieName, token, sessionCookieOptions(session))
  }

  app.post(
    AUTH_PATHS.register,
    {
      schema: {
        body: registerRequestSchema,
        response: { 201: sessionResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await auth.register(request.body, clientMeta(request))
      if (!result.ok) {
        return reply
          .code(409)
          .send(errorBody('CONFLICT', 'An account with this email already exists.', request.id))
      }
      await issueSession(request, reply, result.token)
      return reply.code(201).send(result.body)
    },
  )

  app.post(
    AUTH_PATHS.login,
    {
      schema: {
        body: loginRequestSchema,
        response: { 200: sessionResponseSchema, 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await auth.login(request.body, clientMeta(request))
      if (!result.ok) {
        // One message for unknown email and wrong password (no account enumeration).
        return reply
          .code(401)
          .send(errorBody('UNAUTHORIZED', 'Invalid email or password.', request.id))
      }
      await issueSession(request, reply, result.token)
      return reply.send(result.body)
    },
  )

  app.post(AUTH_PATHS.logout, { preHandler: requireSession }, async (request, reply) => {
    await auth.logout(authOf(request).sessionId)
    void reply.clearCookie(session.cookieName, clearedSessionCookieOptions())
    return reply.code(204).send()
  })

  app.get(
    AUTH_PATHS.session,
    { preHandler: requireSession, schema: { response: { 200: sessionResponseSchema } } },
    async (request) => auth.sessionBody(authOf(request).user),
  )

  return Promise.resolve()
}
