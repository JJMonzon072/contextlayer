import { pino, type Logger } from 'pino'

import type { AppConfig } from './config/env.js'

/**
 * One pino instance for the whole process: Fastify request logs and
 * infrastructure logs (database pool, shutdown) share level, format and redaction.
 * Development gets human-readable output; every other environment logs JSON.
 */
export function createLogger(config: Pick<AppConfig, 'env' | 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
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
