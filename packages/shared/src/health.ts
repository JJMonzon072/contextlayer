import { z } from 'zod'

/** Path of the readiness endpoint (dependency checks included). */
export const HEALTH_PATH = '/health'

/** Path of the liveness endpoint (process is up; no dependency checks). */
export const LIVENESS_PATH = '/health/live'

export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  /** Time the check took, in milliseconds. */
  latencyMs: z.number().nonnegative(),
})

/**
 * Body returned by `GET /health`.
 *
 * The API answers 200 when every dependency is `up` and 503 otherwise; the body
 * has the same shape in both cases so clients can render a precise status.
 */
export const healthReportSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  service: z.literal('contextlayer-api'),
  version: z.string().min(1),
  timestamp: z.iso.datetime(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    database: dependencyCheckSchema,
  }),
})

export const livenessReportSchema = z.object({
  status: z.literal('ok'),
})

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>
export type HealthReport = z.infer<typeof healthReportSchema>
export type LivenessReport = z.infer<typeof livenessReportSchema>
