import type { LightMyRequestResponse } from 'fastify'

import { buildApp } from '../../../src/app.js'
import type { AppConfig } from '../../../src/config/env.js'
import { testConfig } from '../../support/config.js'
import { connectTestDatabase } from './test-database.js'

export type TestApp = Awaited<ReturnType<typeof buildApp>>

/** The real app on the test database. `app.close()` also closes its pool. */
export function buildTestApp(options: { now?: () => Date; config?: Partial<AppConfig> } = {}) {
  return buildApp({
    config: testConfig(options.config),
    database: connectTestDatabase(),
    ...(options.now && { now: options.now }),
  })
}

/** A clock tests can move forward. */
export function controllableClock(start = new Date()) {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms)
    },
  }
}

export const COOKIE = 'cl_session'

export function sessionCookie(response: LightMyRequestResponse) {
  return response.cookies.find((cookie) => cookie.name === COOKIE)
}

/** `cookie` header carrying the session set by `response`. */
export function cookieHeader(response: LightMyRequestResponse): string {
  const cookie = sessionCookie(response)
  if (!cookie) throw new Error('response did not set a session cookie')
  return `${COOKIE}=${cookie.value}`
}

export const PASSWORD = 'correct horse battery staple'

export async function register(app: TestApp, email: string, displayName = 'Test User') {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName },
  })
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`)
  return {
    response,
    cookie: cookieHeader(response),
    userId: response.json<{ user: { id: string } }>().user.id,
  }
}
