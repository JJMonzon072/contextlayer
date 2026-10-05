import {
  addMemberRequestSchema,
  apiErrorSchema,
  createWorkspaceRequestSchema,
  memberListSchema,
  memberSchema,
  updateMemberRoleRequestSchema,
  WORKSPACES_PATH,
  workspaceListSchema,
  workspaceSummarySchema,
} from '@contextlayer/shared'
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { errorBody } from '../../http/error-handler.js'
import { authOf } from '../auth/require-session.js'
import type { WorkspaceError, WorkspacesService } from './workspaces.service.js'

interface WorkspaceRoutesOptions {
  workspaces: WorkspacesService
  requireSession: preHandlerAsyncHookHandler
}

const workspaceParams = z.object({ workspaceId: z.uuid() })
const memberParams = z.object({ workspaceId: z.uuid(), userId: z.uuid() })

const ERRORS: Record<WorkspaceError, { status: 403 | 404 | 409; message: string }> = {
  'not-found': { status: 404, message: 'Workspace not found.' },
  forbidden: { status: 403, message: 'Your role in this workspace does not allow this.' },
  'user-not-found': { status: 404, message: 'No account uses this email.' },
  'member-not-found': { status: 404, message: 'Member not found.' },
  'already-member': { status: 409, message: 'This person is already a member.' },
  'last-owner': { status: 409, message: 'A workspace must keep at least one owner.' },
}

const CODES = { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' } as const

function sendError(request: FastifyRequest, reply: FastifyReply, error: WorkspaceError) {
  const { status, message } = ERRORS[error]
  return reply.code(status).send(errorBody(CODES[status], message, request.id))
}

const errorResponses = { 403: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }

/**
 * Tenant routes. Every handler passes the caller's user id to the service,
 * which checks membership before touching any workspace data.
 */
export const workspaceRoutes: FastifyPluginAsyncZod<WorkspaceRoutesOptions> = (app, options) => {
  const { workspaces, requireSession } = options
  app.addHook('preHandler', requireSession)

  app.get(
    WORKSPACES_PATH,
    { schema: { response: { 200: workspaceListSchema } } },
    async (request) => ({
      items: await workspaces.listForUser(authOf(request).user.id),
    }),
  )

  app.post(
    WORKSPACES_PATH,
    { schema: { body: createWorkspaceRequestSchema, response: { 201: workspaceSummarySchema } } },
    async (request, reply) => {
      const workspace = await workspaces.create(authOf(request).user.id, request.body.name)
      return reply.code(201).send(workspace)
    },
  )

  app.get(
    `${WORKSPACES_PATH}/:workspaceId`,
    {
      schema: {
        params: workspaceParams,
        response: { 200: workspaceSummarySchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await workspaces.get(authOf(request).user.id, request.params.workspaceId)
      return result.ok ? reply.send(result.value) : sendError(request, reply, result.error)
    },
  )

  app.get(
    `${WORKSPACES_PATH}/:workspaceId/members`,
    { schema: { params: workspaceParams, response: { 200: memberListSchema, ...errorResponses } } },
    async (request, reply) => {
      const result = await workspaces.listMembers(
        authOf(request).user.id,
        request.params.workspaceId,
      )
      return result.ok
        ? reply.send({ items: result.value })
        : sendError(request, reply, result.error)
    },
  )

  app.post(
    `${WORKSPACES_PATH}/:workspaceId/members`,
    {
      schema: {
        params: workspaceParams,
        body: addMemberRequestSchema,
        response: { 201: memberSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await workspaces.addMember(
        authOf(request).user.id,
        request.params.workspaceId,
        request.body,
      )
      return result.ok
        ? reply.code(201).send(result.value)
        : sendError(request, reply, result.error)
    },
  )

  app.patch(
    `${WORKSPACES_PATH}/:workspaceId/members/:userId`,
    {
      schema: {
        params: memberParams,
        body: updateMemberRoleRequestSchema,
        response: { 200: memberSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await workspaces.updateRole(
        authOf(request).user.id,
        request.params.workspaceId,
        request.params.userId,
        request.body.role,
      )
      return result.ok ? reply.send(result.value) : sendError(request, reply, result.error)
    },
  )

  app.delete(
    `${WORKSPACES_PATH}/:workspaceId/members/:userId`,
    { schema: { params: memberParams, response: { 204: z.undefined(), ...errorResponses } } },
    async (request, reply) => {
      const result = await workspaces.removeMember(
        authOf(request).user.id,
        request.params.workspaceId,
        request.params.userId,
      )
      return result.ok ? reply.code(204).send() : sendError(request, reply, result.error)
    },
  )

  return Promise.resolve()
}
