import {
  connectionCodeSchema,
  connectionListSchema,
  createConnectionCodeRequestSchema,
  EXTENSION_PATHS,
  extensionConnectionInfoSchema,
  extensionTokenRequestSchema,
  extensionTokenResponseSchema,
} from '@contextlayer/shared'
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AppConfig } from '../../config/env.js'
import {
  domainErrorResponses,
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
}

/**
 * Authentication per route (ADR 0015):
 * - POST codes, GET connections, DELETE connections/:id
 *                         dashboard session cookie + CSRF guard
 * - POST token            credential in the body only (no cookie, no bearer);
 *                         exempt from the CSRF guard because it reads no cookie
 * - POST revoke, GET session   extension access token (bearer)
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
      schema: { response: { 204: z.undefined(), ...domainErrorResponses } },
    },
    async (request, reply) => {
      await extension.revoke(extensionAuthOf(request).grantId, 'disconnected')
      return reply.code(204).send()
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
