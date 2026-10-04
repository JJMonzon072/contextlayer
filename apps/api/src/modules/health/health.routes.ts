import {
  HEALTH_PATH,
  LIVENESS_PATH,
  healthReportSchema,
  livenessReportSchema,
} from '@contextlayer/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

import type { HealthService } from './health.service.js'

/**
 * - `GET /health/live`: liveness. Answers as long as the process can serve HTTP.
 * - `GET /health`: readiness. 200 when every dependency is up, 503 otherwise.
 *   Both status codes return the same `HealthReport` body.
 */
export const healthRoutes: FastifyPluginAsyncZod<{ healthService: HealthService }> = (
  app,
  { healthService },
) => {
  app.addHook('onSend', async (_request, reply) => {
    void reply.header('cache-control', 'no-store')
  })

  app.get(
    LIVENESS_PATH,
    { schema: { response: { 200: livenessReportSchema } } },
    () => ({ status: 'ok' }) as const,
  )

  app.get(
    HEALTH_PATH,
    { schema: { response: { 200: healthReportSchema, 503: healthReportSchema } } },
    async (_request, reply) => {
      const report = await healthService.getReport()
      return reply.code(report.status === 'ok' ? 200 : 503).send(report)
    },
  )

  return Promise.resolve()
}
