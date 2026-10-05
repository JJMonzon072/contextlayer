import { apiErrorSchema } from '@contextlayer/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { errorBody } from './error-handler.js'

/** A client-safe answer for a domain error returned by a service. */
export interface DomainErrorReply {
  status: 400 | 403 | 404 | 409
  message: string
}

const CODES = { 400: 'BAD_REQUEST', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' } as const

export function sendDomainError(
  request: FastifyRequest,
  reply: FastifyReply,
  { status, message }: DomainErrorReply,
) {
  return reply.code(status).send(errorBody(CODES[status], message, request.id))
}

export const domainErrorResponses = {
  400: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
}

/** Same body as a non-member gets for any workspace route (Phase 2). */
export const WORKSPACE_NOT_FOUND: DomainErrorReply = {
  status: 404,
  message: 'Workspace not found.',
}
export const ROLE_FORBIDDEN: DomainErrorReply = {
  status: 403,
  message: 'Your role in this workspace does not allow this.',
}
export const INVALID_CURSOR: DomainErrorReply = { status: 400, message: 'Invalid cursor.' }
