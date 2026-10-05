import {
  applicationListQuerySchema,
  applicationListSchema,
  applicationSchema,
  createApplicationRequestSchema,
  updateApplicationRequestSchema,
  WORKSPACES_PATH,
} from '@contextlayer/shared'
import type { preHandlerAsyncHookHandler } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { decodeCursor } from '../../http/cursor.js'
import {
  domainErrorResponses,
  INVALID_CURSOR,
  ROLE_FORBIDDEN,
  sendDomainError,
  WORKSPACE_NOT_FOUND,
  type DomainErrorReply,
} from '../../http/domain-errors.js'
import { authOf } from '../auth/require-session.js'
import type { ApplicationError, ApplicationsService } from './applications.service.js'

interface ApplicationRoutesOptions {
  applications: ApplicationsService
  requireSession: preHandlerAsyncHookHandler
}

const ERRORS: Record<ApplicationError, DomainErrorReply> = {
  'not-found': WORKSPACE_NOT_FOUND,
  forbidden: ROLE_FORBIDDEN,
  'application-not-found': { status: 404, message: 'Application not found.' },
  'has-guides': {
    status: 409,
    message: 'This application has guides, so it cannot be deleted: their history is kept.',
  },
}

const BASE = `${WORKSPACES_PATH}/:workspaceId/applications`
const workspaceParams = z.object({ workspaceId: z.uuid() })
const applicationParams = z.object({ workspaceId: z.uuid(), applicationId: z.uuid() })

export const applicationRoutes: FastifyPluginAsyncZod<ApplicationRoutesOptions> = (
  app,
  options,
) => {
  const { applications, requireSession } = options
  app.addHook('preHandler', requireSession)

  app.get(
    BASE,
    {
      schema: {
        params: workspaceParams,
        querystring: applicationListQuerySchema,
        response: { 200: applicationListSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { limit, cursor } = request.query
      const afterId = cursor === undefined ? undefined : decodeCursor(cursor)
      if (cursor !== undefined && afterId === undefined) {
        return sendDomainError(request, reply, INVALID_CURSOR)
      }
      const result = await applications.list(authOf(request).user.id, request.params.workspaceId, {
        limit,
        afterId,
      })
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.post(
    BASE,
    {
      schema: {
        params: workspaceParams,
        body: createApplicationRequestSchema,
        response: { 201: applicationSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await applications.create(
        authOf(request).user.id,
        request.params.workspaceId,
        request.body,
      )
      return result.ok
        ? reply.code(201).send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.get(
    `${BASE}/:applicationId`,
    {
      schema: {
        params: applicationParams,
        response: { 200: applicationSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { workspaceId, applicationId } = request.params
      const result = await applications.get(authOf(request).user.id, workspaceId, applicationId)
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.patch(
    `${BASE}/:applicationId`,
    {
      schema: {
        params: applicationParams,
        body: updateApplicationRequestSchema,
        response: { 200: applicationSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { workspaceId, applicationId } = request.params
      const result = await applications.update(
        authOf(request).user.id,
        workspaceId,
        applicationId,
        request.body,
      )
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.delete(
    `${BASE}/:applicationId`,
    {
      schema: {
        params: applicationParams,
        response: { 204: z.undefined(), ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { workspaceId, applicationId } = request.params
      const result = await applications.remove(authOf(request).user.id, workspaceId, applicationId)
      return result.ok
        ? reply.code(204).send()
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  return Promise.resolve()
}
