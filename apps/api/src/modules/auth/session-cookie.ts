import type { CookieSerializeOptions } from '@fastify/cookie'

import type { SessionConfig } from '../../config/env.js'

/**
 * Flags of the dashboard session cookie (ADR 0015). Identical in every
 * environment; only the name differs (`__Host-` prefix in production, see
 * `sessionCookieName`). `Secure` is kept in development: Chrome and Firefox
 * accept Secure cookies on http://localhost (Safari does not).
 */
export function sessionCookieOptions(config: SessionConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(config.absoluteTimeoutMs / 1000),
  }
}

/** Clearing must repeat the attributes, or a `__Host-` cookie is not replaced. */
export function clearedSessionCookieOptions(): CookieSerializeOptions {
  return { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0 }
}
