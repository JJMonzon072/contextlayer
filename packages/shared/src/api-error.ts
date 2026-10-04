import { z } from 'zod'

/**
 * Stable, machine-readable error codes. Clients branch on `code`, never on the
 * human-readable `message`, so messages can change without breaking anyone.
 */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES)

/** Envelope used by every non-2xx JSON response of the API. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Correlates the response with the API logs. */
    requestId: z.string().optional(),
  }),
})

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>
export type ApiError = z.infer<typeof apiErrorSchema>
