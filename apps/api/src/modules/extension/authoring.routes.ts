import {
  authoringCreateGuideRequestSchema,
  EXTENSION_AUTHORING_PATH,
  guideListSchema,
  guideSchema,
  pageQuerySchema,
  replaceStepsRequestSchema,
  type CreateGuideRequest,
  type Guide,
  type GuideList,
  type ReplaceStepsRequest,
} from '@contextlayer/shared'
import type { onRequestAsyncHookHandler } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { decodeCursor } from '../../http/cursor.js'
import {
  domainErrorResponses,
  INVALID_CURSOR,
  ROLE_FORBIDDEN,
  sendDomainError,
  type DomainErrorReply,
} from '../../http/domain-errors.js'
import { extensionAuthOf } from './require-extension-access.js'

export type AuthoringError =
  | 'forbidden'
  | 'not-found'
  | 'application-not-found'
  | 'guide-not-found'
  | 'archived'
  | 'revision-conflict'
  | 'step-not-found'

export type AuthoringResult<T> = { ok: true; value: T } | { ok: false; error: AuthoringError }

/**
 * What guide authoring from the extension needs from the applications and
 * guides modules (wired in app.ts to their services, so step replacement,
 * transactions, revisions and tenant isolation are the dashboard's own).
 * Every call takes the user and workspace of the grant, never a client value,
 * and the guides service checks the caller's current role on each call.
 */
export interface AuthoringDirectory {
  applicationExists(workspaceId: string, applicationId: string): Promise<boolean>
  list(
    userId: string,
    workspaceId: string,
    query: { applicationId: string; limit: number; afterId: string | undefined },
  ): Promise<AuthoringResult<GuideList>>
  get(userId: string, workspaceId: string, guideId: string): Promise<AuthoringResult<Guide>>
  create(
    userId: string,
    workspaceId: string,
    input: CreateGuideRequest,
  ): Promise<AuthoringResult<Guide>>
  replaceSteps(
    userId: string,
    workspaceId: string,
    guideId: string,
    input: ReplaceStepsRequest,
  ): Promise<AuthoringResult<Guide>>
}

interface AuthoringRoutesOptions {
  authoring: AuthoringDirectory
  requireExtensionAccess: onRequestAsyncHookHandler
}

const ERRORS: Record<AuthoringError, DomainErrorReply> = {
  forbidden: ROLE_FORBIDDEN,
  // The grant's workspace no longer has this user: the token is refused first,
  // so this only shows up in a race with a membership change.
  'not-found': { status: 404, message: 'Workspace not found.' },
  'application-not-found': { status: 404, message: 'Application not found.' },
  'guide-not-found': { status: 404, message: 'Guide not found.' },
  archived: { status: 409, message: 'This guide is archived. Restore it in the dashboard.' },
  'revision-conflict': {
    status: 409,
    message: 'This guide was changed somewhere else. Load the latest draft before saving.',
  },
  'step-not-found': {
    status: 404,
    message: 'A step in the request does not belong to this guide.',
  },
}

/** Same limit as the dashboard's step replacement: 50 steps at their limits. */
const STEPS_BODY_LIMIT = 2 * 1024 * 1024
const applicationParams = z.object({ applicationId: z.uuid() })
const guideParams = applicationParams.extend({ guideId: z.uuid() })
const BASE = `${EXTENSION_AUTHORING_PATH}/applications/:applicationId/guides`

/**
 * Guide authoring for the extension's side panel (Phase 5). Bearer only: the
 * access check runs on `onRequest`, before the body is even parsed, and never
 * falls back to the dashboard cookie. The guide must belong to the application
 * in the path, and the application to the grant's workspace; anything else
 * answers 404, exactly like an id that does not exist.
 */
export const authoringRoutes: FastifyPluginAsyncZod<AuthoringRoutesOptions> = (app, options) => {
  const { authoring, requireExtensionAccess } = options
  app.addHook('onRequest', requireExtensionAccess)

  /** The guide when it is this application's and still editable. */
  async function editableGuide(
    userId: string,
    workspaceId: string,
    applicationId: string,
    guideId: string,
  ): Promise<AuthoringResult<Guide>> {
    const result = await authoring.get(userId, workspaceId, guideId)
    if (!result.ok) return result
    if (result.value.applicationId !== applicationId) return { ok: false, error: 'guide-not-found' }
    if (result.value.status === 'archived') return { ok: false, error: 'archived' }
    return result
  }

  app.get(
    BASE,
    {
      schema: {
        params: applicationParams,
        querystring: pageQuerySchema,
        response: { 200: guideListSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { userId, workspaceId } = extensionAuthOf(request)
      const { applicationId } = request.params
      const { limit, cursor } = request.query
      const afterId = cursor === undefined ? undefined : decodeCursor(cursor)
      if (cursor !== undefined && afterId === undefined) {
        return sendDomainError(request, reply, INVALID_CURSOR)
      }
      // Role first: a member gets 403 whatever the application.
      const result = await authoring.list(userId, workspaceId, { applicationId, limit, afterId })
      if (!result.ok) return sendDomainError(request, reply, ERRORS[result.error])
      if (!(await authoring.applicationExists(workspaceId, applicationId))) {
        return sendDomainError(request, reply, ERRORS['application-not-found'])
      }
      return reply.send(result.value)
    },
  )

  app.post(
    BASE,
    {
      schema: {
        params: applicationParams,
        body: authoringCreateGuideRequestSchema,
        response: { 201: guideSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { userId, workspaceId } = extensionAuthOf(request)
      const result = await authoring.create(userId, workspaceId, {
        applicationId: request.params.applicationId,
        title: request.body.title,
      })
      return result.ok
        ? reply.code(201).send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.get(
    `${BASE}/:guideId`,
    { schema: { params: guideParams, response: { 200: guideSchema, ...domainErrorResponses } } },
    async (request, reply) => {
      const { userId, workspaceId } = extensionAuthOf(request)
      const { applicationId, guideId } = request.params
      const result = await editableGuide(userId, workspaceId, applicationId, guideId)
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  app.put(
    `${BASE}/:guideId/steps`,
    {
      bodyLimit: STEPS_BODY_LIMIT,
      schema: {
        params: guideParams,
        body: replaceStepsRequestSchema,
        response: { 200: guideSchema, ...domainErrorResponses },
      },
    },
    async (request, reply) => {
      const { userId, workspaceId } = extensionAuthOf(request)
      const { applicationId, guideId } = request.params
      const checked = await editableGuide(userId, workspaceId, applicationId, guideId)
      if (!checked.ok) return sendDomainError(request, reply, ERRORS[checked.error])
      // The service locks the guide, re-checks the revision and the archive
      // state, and replaces every step in one transaction.
      const result = await authoring.replaceSteps(userId, workspaceId, guideId, request.body)
      return result.ok
        ? reply.send(result.value)
        : sendDomainError(request, reply, ERRORS[result.error])
    },
  )

  return Promise.resolve()
}
