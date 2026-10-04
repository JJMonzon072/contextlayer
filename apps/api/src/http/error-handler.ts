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

export function errorBody(code: ApiErrorCode, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } }
}

/**
 * Every error leaves the API in the shared `ApiError` envelope. 5xx details are
 * logged with the request id but never sent to the client.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(errorBody('NOT_FOUND', 'Route not found', request.id))
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_FAILED', 'Request validation failed', request.id))
    }

    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error')
      return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error', request.id))
    }

    const code = CODE_BY_STATUS[statusCode] ?? 'BAD_REQUEST'
    return reply.code(statusCode).send(errorBody(code, error.message, request.id))
  })
}
