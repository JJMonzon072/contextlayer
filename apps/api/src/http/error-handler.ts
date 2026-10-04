import type { ApiError, ApiErrorCode } from '@contextlayer/shared'
import type { FastifyError, FastifyInstance } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'

const CODE_BY_STATUS: Partial<Record<number, ApiErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
}

/** Client-facing messages for errors whose own message may contain internals. */
const GENERIC_MESSAGES: Record<ApiErrorCode, string> = {
  BAD_REQUEST: 'Bad request',
  VALIDATION_FAILED: 'Request validation failed',
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: 'Internal server error',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
}

export function errorBody(code: ApiErrorCode, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } }
}

/** Fastify's own errors (`FST_*`) carry short, input-free messages that are safe to return. */
function isFastifyError(error: FastifyError): boolean {
  return typeof error.code === 'string' && error.code.startsWith('FST_')
}

/**
 * Every error leaves the API in the shared `ApiError` envelope:
 * - schema validation failures → 400 `VALIDATION_FAILED`;
 * - 5xx → logged with the request id; the client only gets a generic message
 *   (503 is preserved so clients and load balancers can tell "try later" from a crash);
 * - 4xx → Fastify's own messages are returned; any other error message is replaced
 *   by a generic one, because it may contain internal details.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(errorBody('NOT_FOUND', 'Route not found', request.id))
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_FAILED', GENERIC_MESSAGES.VALIDATION_FAILED, request.id))
    }

    const statusCode =
      error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed')
      const code: ApiErrorCode = statusCode === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR'
      return reply
        .code(code === 'SERVICE_UNAVAILABLE' ? 503 : 500)
        .send(errorBody(code, GENERIC_MESSAGES[code], request.id))
    }

    request.log.info({ err: error }, 'request rejected')
    const code = CODE_BY_STATUS[statusCode] ?? 'BAD_REQUEST'
    const message = isFastifyError(error) ? error.message : GENERIC_MESSAGES[code]
    return reply.code(statusCode).send(errorBody(code, message, request.id))
  })
}
