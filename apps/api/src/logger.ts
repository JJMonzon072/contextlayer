import { DrizzleQueryError } from 'drizzle-orm'
import { pino, type Logger } from 'pino'

import type { AppConfig } from './config/env.js'

/**
 * One pino instance for the whole process: Fastify request logs and
 * infrastructure logs (database pool, shutdown) share level, format and redaction.
 * Development gets human-readable output; every other environment logs JSON.
 */
/**
 * Error serializer without query parameters: a database error from Drizzle
 * carries `params` (emails, password hashes, session-token hashes), and the
 * PostgreSQL error it wraps can echo values in `detail`. Neither may reach a log.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  const serialized: Record<string, unknown> = { ...pino.stdSerializers.err(error) }
  delete serialized.params
  delete serialized.detail
  if (error instanceof DrizzleQueryError) {
    // Drizzle also writes the values into `message` (and so into `stack`):
    // keep the parameterized SQL text and the stack frames only.
    serialized.message = `Failed query: ${error.query}`
    const frames = (error.stack ?? '').split('\n').filter((line) => line.startsWith('    at '))
    serialized.stack = [`${error.name}: ${String(serialized.message)}`, ...frames].join('\n')
  }
  if (error.cause !== undefined) serialized.cause = serializeError(error.cause)
  return serialized
}

export function createLogger(config: Pick<AppConfig, 'env' | 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    serializers: { err: serializeError },
    // Defense in depth: credentials must never reach the logs, even if a
    // future serializer starts including request headers.
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(config.env === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    }),
  })
}
