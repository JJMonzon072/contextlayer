import { z } from 'zod'

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/**
 * Environment contract of the API process. Validated once at startup so a bad
 * deployment fails fast with a readable message instead of failing later at
 * the first request that touches the missing value.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('localhost'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
})

export interface AppConfig {
  env: 'development' | 'test' | 'production'
  server: { host: string; port: number }
  logLevel: (typeof LOG_LEVELS)[number]
  database: { url: string }
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env)

  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`)
  }

  const values = result.data
  return {
    env: values.NODE_ENV,
    server: { host: values.API_HOST, port: values.API_PORT },
    logLevel: values.LOG_LEVEL,
    database: { url: values.DATABASE_URL },
  }
}
