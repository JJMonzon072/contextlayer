import { randomUUID } from 'node:crypto'

import helmet from '@fastify/helmet'
import Fastify, { type FastifyBaseLogger } from 'fastify'
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { pino } from 'pino'

import { registerErrorHandling } from './http/error-handler.js'
import type { Database } from './infrastructure/database/client.js'
import { healthRoutes } from './modules/health/health.routes.js'
import { createHealthService } from './modules/health/health.service.js'
import { readApiVersion } from './version.js'

export interface AppDependencies {
  database: Pick<Database, 'ping' | 'close'>
  /** Defaults to a silent logger, which keeps tests quiet. */
  logger?: FastifyBaseLogger
}

/**
 * Composition root of the HTTP application. Infrastructure is created by the
 * caller (server.ts in production, fakes in tests) and injected here, so every
 * module can be exercised with `app.inject()` without a network or a database.
 */
export async function buildApp({ database, logger = pino({ level: 'silent' }) }: AppDependencies) {
  const fastify = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
  })

  fastify.setValidatorCompiler(validatorCompiler)
  fastify.setSerializerCompiler(serializerCompiler)
  registerErrorHandling(fastify)

  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id)
  })
  app.addHook('onClose', async () => {
    await database.close()
  })

  await app.register(helmet)

  const healthService = createHealthService({
    probes: { database: () => database.ping() },
    version: readApiVersion(),
    logger: app.log,
  })
  await app.register(healthRoutes, { healthService })

  return app
}
