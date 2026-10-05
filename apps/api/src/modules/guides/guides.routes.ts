import {
  createGuideRequestSchema,
  guideListQuerySchema,
  guideListSchema,
  guideSchema,
  guideVersionListSchema,
  guideVersionSchema,
  publishGuideResponseSchema,
  replaceStepsRequestSchema,
  updateGuideRequestSchema,
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
import type { GuideError, GuidesService } from './guides.service.js'

interface GuideRoutesOptions {
  guides: GuidesService
  requireSession: preHandlerAsyncHookHandler
}

const ERRORS: Record<GuideError, DomainErrorReply> = {
  'not-found': WORKSPACE_NOT_FOUND,
  forbidden: ROLE_FORBIDDEN,
  'guide-not-found': { status: 404, message: 'Guide not found.' },
  'application-not-found': { status: 404, message: 'Application not found.' },
  archived: { status: 409, message: 'This guide is archived. Restore it to change it.' },
  'revision-conflict': {
    status: 409,
    message: 'This guide was changed by someone else. Reload it to see the latest draft.',
  },
  'step-not-found': {
    status: 404,
    message: 'A step in the request does not belong to this guide.',
  },
  'no-steps': { status: 409, message: 'Add at least one step before publishing.' },
  'version-not-found': { status: 404, message: 'Version not found.' },
  'publish-conflict': {
    status: 409,
    message: 'Another publish of this guide just finished. Reload to see the new version.',
  },
}

const BASE = `${WORKSPACES_PATH}/:workspaceId/guides`
const STEPS_BODY_LIMIT = 2 * 1024 * 1024
const workspaceParams = z.object({ workspaceId: z.uuid() })
const guideParams = z.object({ workspaceId: z.uuid(), guideId: z.uuid() })
const versionParams = guideParams.extend({
  version: z.coerce.number().int().min(1).max(1_000_000),
})

export const guideRoutes: FastifyPluginAsyncZod<GuideRoutesOptions> = (app, options) => {
  const { guides, requireSession } = options
  app.addHook('preHandler', requireSession)

  app.get(
    BASE,
    {
      schema: {
        params: workspaceParams,
        querystring: guideListQuerySchema,
        response: { 200: guideListSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { cursor, ...query } = request.query
      const afterId = cursor === undefined ? undefined : decodeCursor(cursor)
      if (cursor !== undefined && afterId === undefined) {
        return sendDomainError(request, reply, INVALID_CURSOR)
      }
      const result = await guides.list(authOf(request).user.id, request.params.workspaceId, {
        ...query,
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
        body: createGuideRequestSchema,
        response: { 201: guideSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await guides.create(
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
    `${BASE}/:guideId`,
    { schema: { params: guideParams, response: { 200: guideSchema, ...domainErrorResponses } } },
    async (request, reply) => {
      const { workspaceId, guideId } = request.params
      const result = await guides.get(authOf(request).user.id, workspaceId, guideId)
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.patch(
    `${BASE}/:guideId`,
    {
      schema: {
        params: guideParams,
        body: updateGuideRequestSchema,
        response: { 200: guideSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { workspaceId, guideId } = request.params
      const result = await guides.update(
        authOf(request).user.id,
        workspaceId,
        guideId,
        request.body,
      )
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.put(
    `${BASE}/:guideId/steps`,
    {
      // 50 steps × (a descriptor of up to 16 KB + instructions) can pass the
      // 1 MiB default while every field is within its contract limits.
      bodyLimit: STEPS_BODY_LIMIT,
      schema: {
        params: guideParams,
        body: replaceStepsRequestSchema,
        response: { 200: guideSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { workspaceId, guideId } = request.params
      const result = await guides.replaceSteps(
        authOf(request).user.id,
        workspaceId,
        guideId,
        request.body,
      )
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  /** 201 with a new version, or 200 with the latest one when the draft did not change. */
  app.post(
    `${BASE}/:guideId/publish`,
    {
      schema: {
        params: guideParams,
        response: {
          200: publishGuideResponseSchema,
          201: publishGuideResponseSchema,
          ...domainErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, guideId } = request.params
      const result = await guides.publish(authOf(request).user.id, workspaceId, guideId)
      if (!result.ok) return sendDomainError(request, reply, ERRORS[result.error])
      return reply.code(result.value.created ? 201 : 200).send(result.value)
    },
  )

  app.get(
    `${BASE}/:guideId/versions`,
    {
      schema: {
        params: guideParams,
        response: { 200: guideVersionListSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { workspaceId, guideId } = request.params
      const result = await guides.listVersions(authOf(request).user.id, workspaceId, guideId)
      return result.ok
        ? reply.send({ items: result.value })
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.get(
    `${BASE}/:guideId/versions/:version`,
    {
      schema: {
        params: versionParams,
        response: { 200: guideVersionSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { workspaceId, guideId, version } = request.params
      const result = await guides.getVersion(authOf(request).user.id, workspaceId, guideId, version)
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  /** Archives (soft delete): published versions are never deleted. */
  app.delete(
    `${BASE}/:guideId`,
    {
      schema: { params: guideParams, response: { 204: z.undefined(), ...domainErrorResponses } },
    },
    async (request, reply) => {
      const { workspaceId, guideId } = request.params
      const result = await guides.archive(authOf(request).user.id, workspaceId, guideId)
      return result.ok
        ? reply.code(204).send()
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.post(
    `${BASE}/:guideId/restore`,
    { schema: { params: guideParams, response: { 200: guideSchema, ...domainErrorResponses } } },
    async (request, reply) => {
      const { workspaceId, guideId } = request.params
      const result = await guides.restore(authOf(request).user.id, workspaceId, guideId)
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  return Promise.resolve()
}
