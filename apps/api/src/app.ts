import { randomUUID } from 'node:crypto'

import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyBaseLogger } from 'fastify'
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { pino } from 'pino'

import type { AppConfig } from './config/env.js'
import { registerCsrfGuard } from './http/csrf-guard.js'
import { registerErrorHandling } from './http/error-handler.js'
import type { Database } from './infrastructure/database/client.js'
import { applicationRoutes } from './modules/applications/applications.routes.js'
import { createApplicationsService } from './modules/applications/applications.service.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { createAuthService } from './modules/auth/auth.service.js'
import { guideRoutes } from './modules/guides/guides.routes.js'
import { createGuidesService } from './modules/guides/guides.service.js'
import { createRequireSession } from './modules/auth/require-session.js'
import { healthRoutes } from './modules/health/health.routes.js'
import { createHealthService } from './modules/health/health.service.js'
import { workspaceRoutes } from './modules/workspaces/workspaces.routes.js'
import { createWorkspacesService } from './modules/workspaces/workspaces.service.js'
import { readApiVersion } from './version.js'

/** Upper bound for each dependency probe of `GET /health`. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000

export interface AppDependencies {
  config: AppConfig
  database: Database
  /** Defaults to a silent logger, which keeps tests quiet. */
  logger?: FastifyBaseLogger
  /** Injectable clock: session expiry is tested without waiting. */
  now?: () => Date
}

/**
 * Composition root of the HTTP application. Infrastructure is created by the
 * caller (server.ts in production, the test database or fakes in tests) and
 * injected here; modules are wired to each other only in this function.
 */
export async function buildApp({
  config,
  database,
  logger = pino({ level: 'silent' }),
  now = () => new Date(),
}: AppDependencies) {
  const fastify = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    // Only named proxies may set the client address (rate limits key on request.ip).
    trustProxy: config.http.trustProxy.length > 0 ? config.http.trustProxy : false,
  })

  fastify.setValidatorCompiler(validatorCompiler)
  fastify.setSerializerCompiler(serializerCompiler)
  registerErrorHandling(fastify)

  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.decorateRequest('auth', null)
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id)
  })
  app.addHook('onClose', async () => {
    await database.close()
  })

  // JSON only: text/plain is one of the bodies a cross-site form can send
  // without a CORS preflight, so it is not accepted at all (415).
  app.removeContentTypeParser('text/plain')
  registerCsrfGuard(app, config.http.dashboardOrigins)

  await app.register(helmet)
  await app.register(cookie)
  // No global limit: routes opt in (auth routes). The thrown error reaches the
  // error handler, which answers 429 RATE_LIMITED; the plugin adds retry-after.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error('rate limit exceeded'), { statusCode: context.statusCode }),
  })

  const healthService = createHealthService({
    probes: { database: () => database.ping({ timeoutMs: HEALTH_PROBE_TIMEOUT_MS }) },
    version: readApiVersion(),
    logger: app.log,
    timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
  })
  await app.register(healthRoutes, { healthService })

  // Modules depend on each other only through these service interfaces.
  const auth = createAuthService({
    db: database.db,
    session: config.session,
    now,
    listWorkspaces: (userId) => workspaces.listForUser(userId),
  })
  const workspaces = createWorkspacesService({ db: database.db, users: auth })
  const memberships = {
    roleOf: (workspaceId: string, userId: string) => workspaces.roleOf(workspaceId, userId),
  }
  const applications = createApplicationsService({ db: database.db, memberships })
  const guides = createGuidesService({ db: database.db, memberships, applications })
  const requireSession = createRequireSession(auth, config.session.cookieName)

  // Versioned product API: authenticated data must never sit in a cache.
  await app.register(async (v1) => {
    v1.addHook('onSend', async (_request, reply) => {
      void reply.header('cache-control', 'no-store')
    })
    await v1.register(authRoutes, {
      auth,
      session: config.session,
      rateLimits: config.rateLimits,
      requireSession,
    })
    await v1.register(workspaceRoutes, { workspaces, requireSession })
    await v1.register(applicationRoutes, { applications, requireSession })
    await v1.register(guideRoutes, { guides, requireSession })
  })

  return app
}
