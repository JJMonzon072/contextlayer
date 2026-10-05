import {
  connectionCodeSchema,
  connectionListSchema,
  createConnectionCodeRequestSchema,
  EXTENSION_PATHS,
  extensionApplicationListSchema,
  extensionConnectionInfoSchema,
  extensionRevokeRequestSchema,
  extensionTokenRequestSchema,
  extensionTokenResponseSchema,
  publishedGuideListSchema,
  publishedGuideQuerySchema,
  publishedGuideSchema,
} from '@contextlayer/shared'
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AppConfig } from '../../config/env.js'
import { decodeCursor } from '../../http/cursor.js'
import {
  domainErrorResponses,
  INVALID_CURSOR,
  sendDomainError,
  WORKSPACE_NOT_FOUND,
  type DomainErrorReply,
} from '../../http/domain-errors.js'
import { authOf } from '../auth/require-session.js'
import type { ExtensionError, ExtensionService } from './extension.service.js'
import { extensionAuthOf } from './require-extension-access.js'

interface ExtensionRoutesOptions {
  extension: ExtensionService
  rateLimits: AppConfig['rateLimits']
  requireSession: preHandlerAsyncHookHandler
  requireExtensionAccess: preHandlerAsyncHookHandler
}

const ERRORS: Record<ExtensionError, DomainErrorReply> = {
  'not-found': WORKSPACE_NOT_FOUND,
  'invalid-grant': {
    status: 400,
    message: 'The connection code or refresh token is invalid, expired or already used.',
  },
  'connection-not-found': { status: 404, message: 'Connection not found.' },
  'invalid-origin': {
    status: 400,
    message: 'origin must be an exact origin such as https://app.example.com.',
  },
  'guide-not-found': { status: 404, message: 'Guide not found.' },
}

/** Applications per connection are few; the list is bounded instead of paginated. */
const APPLICATION_LIST_LIMIT = 100

/**
 * Authentication per route (ADR 0015):
 * - POST codes, GET connections, DELETE connections/:id
 *                         dashboard session cookie + CSRF guard
 * - POST token            credential in the body only (no cookie, no bearer);
 *                         exempt from the CSRF guard because it reads no cookie
 * - POST revoke, GET session, applications, guides, guides/:id
 *                         extension access token (bearer); the workspace is the
 *                         grant's, never a value from the request
 */
export const extensionRoutes: FastifyPluginAsyncZod<ExtensionRoutesOptions> = (app, options) => {
  const { extension, rateLimits, requireSession, requireExtensionAccess } = options
  const perClient = (prefix: string) => (request: FastifyRequest) => `${prefix}:${request.ip}`

  app.post(
    EXTENSION_PATHS.codes,
    {
      preHandler: requireSession,
      config: {
        rateLimit: {
          max: rateLimits.extensionCodeMax,
          timeWindow: rateLimits.windowMs,
          keyGenerator: perClient('extension-code'),
        },
      },
      schema: {
        body: createConnectionCodeRequestSchema,
        response: { 201: connectionCodeSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await extension.issueCode(authOf(request).user.id, request.body)
      return result.ok
        ? reply.code(201).send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.post(
    EXTENSION_PATHS.token,
    {
      config: {
        csrf: false,
        rateLimit: {
          max: rateLimits.extensionTokenMax,
          timeWindow: rateLimits.windowMs,
          keyGenerator: perClient('extension-token'),
        },
      },
      schema: {
        body: extensionTokenRequestSchema,
        response: { 200: extensionTokenResponseSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const body = request.body
      const result =
        body.grantType === 'authorization_code'
          ? await extension.exchangeCode(body)
          : await extension.refresh(body)
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.get(
    EXTENSION_PATHS.connections,
    { preHandler: requireSession, schema: { response: { 200: connectionListSchema } } },
    async (request) => ({ items: await extension.listConnections(authOf(request).user.id) }),
  )

  app.delete(
    `${EXTENSION_PATHS.connections}/:connectionId`,
    {
      preHandler: requireSession,
      schema: {
        params: z.object({ connectionId: z.uuid() }),
        response: { 204: z.undefined(), ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await extension.revokeConnection(
        authOf(request).user.id,
        request.params.connectionId,
      )
      return result.ok
        ? reply.code(204).send()
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  /** The extension disconnecting itself. Bearer requests skip the CSRF guard. */
  app.post(
    EXTENSION_PATHS.revoke,
    {
      preHandler: requireExtensionAccess,
      // The optional body is parsed after authentication: route validation would
      // otherwise answer 400 to a request that has no valid token at all.
      schema: { response: { 204: z.undefined(), ...domainErrorResponses } },
    },
    async (request, reply) => {
      const body = extensionRevokeRequestSchema.safeParse(request.body ?? {})
      if (!body.success) {
        return sendDomainError(request, reply, {
          status: 400,
          message: 'Invalid revocation reason.',
        })
      }
      await extension.revoke(extensionAuthOf(request).grantId, body.data.reason)
      return reply.code(204).send()
    },
  )

  app.get(
    EXTENSION_PATHS.applications,
    {
      preHandler: requireExtensionAccess,
      schema: { response: { 200: extensionApplicationListSchema } },
    },
    async (request) => ({
      items: (await extension.applications(extensionAuthOf(request))).slice(
        0,
        APPLICATION_LIST_LIMIT,
      ),
    }),
  )

  app.get(
    EXTENSION_PATHS.guides,
    {
      preHandler: requireExtensionAccess,
      schema: {
        querystring: publishedGuideQuerySchema,
        response: { 200: publishedGuideListSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { origin, limit, cursor } = request.query
      const afterId = cursor === undefined ? undefined : decodeCursor(cursor)
      if (cursor !== undefined && afterId === undefined) {
        return sendDomainError(request, reply, INVALID_CURSOR)
      }
      const result = await extension.publishedGuides(extensionAuthOf(request), {
        origin,
        limit,
        afterId,
      })
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.get(
    `${EXTENSION_PATHS.guides}/:guideId`,
    {
      preHandler: requireExtensionAccess,
      schema: {
        params: z.object({ guideId: z.uuid() }),
        response: { 200: publishedGuideSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await extension.publishedGuide(
        extensionAuthOf(request),
        request.params.guideId,
      )
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.get(
    EXTENSION_PATHS.session,
    {
      preHandler: requireExtensionAccess,
      schema: { response: { 200: extensionConnectionInfoSchema, ...domainErrorResponses } },
    },
    async (request, reply) => {
      const info = await extension.session(extensionAuthOf(request))
      return info
        ? reply.send(info)
        : sendDomainError(request, reply, ERRORS['connection-not-found'])
    },
  )

  return Promise.resolve()
}
