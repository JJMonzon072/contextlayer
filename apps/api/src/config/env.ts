import { z } from 'zod'

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/** Vite dev server and `vite preview` (the e2e suites run against preview). */
const DEVELOPMENT_DASHBOARD_ORIGINS = ['http://localhost:5173', 'http://localhost:4173']

const positiveInt = () => z.coerce.number().int().min(1)

/**
 * Environment contract of the API process. Validated once at startup so a bad
 * deployment fails fast with a readable message instead of failing later at
 * the first request that touches the missing value.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('localhost'),
  API_PORT: positiveInt().max(65_535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Session lifetimes (ADR 0015): idle timeout and absolute lifetime.
  SESSION_IDLE_MINUTES: positiveInt()
    .max(24 * 60)
    .default(30),
  SESSION_ABSOLUTE_HOURS: positiveInt()
    .max(30 * 24)
    .default(8),
  // CSRF allow-list: the exact dashboard origins, comma-separated. Required in production.
  DASHBOARD_ORIGIN: z.string().optional(),
  // Reverse-proxy addresses (IP or CIDR, comma-separated) whose X-Forwarded-For is trusted.
  TRUST_PROXY: z.string().default(''),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: positiveInt().default(900),
  LOGIN_RATE_LIMIT_MAX: positiveInt().default(10),
  REGISTER_RATE_LIMIT_MAX: positiveInt().default(20),
})

export interface AppConfig {
  env: 'development' | 'test' | 'production'
  server: { host: string; port: number }
  logLevel: (typeof LOG_LEVELS)[number]
  database: { url: string }
  session: SessionConfig
  http: {
    /** Exact `Origin` values allowed to send cookie-authenticated unsafe requests. */
    dashboardOrigins: string[]
    /** Proxies whose X-Forwarded-For is trusted; empty means `request.ip` is the peer. */
    trustProxy: string[]
  }
  rateLimits: {
    windowMs: number
    /** Per client IP + email: password guessing against one account. */
    loginMax: number
    /** Per client IP: bulk account creation. */
    registerMax: number
  }
}

export interface SessionConfig {
  cookieName: string
  idleTimeoutMs: number
  absoluteTimeoutMs: number
}

/**
 * Production uses the `__Host-` prefix: the browser then only accepts the cookie
 * when it is Secure, has `Path=/` and no `Domain`, so a sibling subdomain cannot
 * overwrite it. On http://localhost the prefix is not relied on (Chrome has
 * historically rejected prefixed cookies there), so development uses a plain name.
 * Every other flag is identical in both environments (see session-cookie.ts).
 */
export function sessionCookieName(env: AppConfig['env']): string {
  return env === 'production' ? '__Host-cl_session' : 'cl_session'
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
    session: {
      cookieName: sessionCookieName(values.NODE_ENV),
      idleTimeoutMs: values.SESSION_IDLE_MINUTES * 60_000,
      absoluteTimeoutMs: values.SESSION_ABSOLUTE_HOURS * 3_600_000,
    },
    http: {
      dashboardOrigins: parseOrigins(values.DASHBOARD_ORIGIN, values.NODE_ENV),
      trustProxy: splitList(values.TRUST_PROXY),
    },
    rateLimits: {
      windowMs: values.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
      loginMax: values.LOGIN_RATE_LIMIT_MAX,
      registerMax: values.REGISTER_RATE_LIMIT_MAX,
    },
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** Each entry must be a bare origin (`scheme://host[:port]`), compared verbatim with `Origin`. */
function parseOrigins(value: string | undefined, env: AppConfig['env']): string[] {
  const origins = splitList(value)
  if (origins.length === 0) {
    if (env === 'production') {
      throw new ConfigError(
        'Invalid environment configuration:\nDASHBOARD_ORIGIN is required in production.',
      )
    }
    return DEVELOPMENT_DASHBOARD_ORIGINS
  }
  for (const origin of origins) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
      throw new ConfigError(
        `Invalid environment configuration:\nDASHBOARD_ORIGIN entries must be bare origins such as https://app.example.com, got "${origin}".`,
      )
    }
  }
  return origins
}
