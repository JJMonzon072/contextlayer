import { apiErrorSchema } from '@contextlayer/shared'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, PASSWORD, register, sessionCookie, type TestApp } from './support/app.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp | undefined

afterAll(() => database.close())
beforeEach(() => resetTestDatabase(database))
afterEach(async () => {
  await app?.close()
  app = undefined
})

function loginWith(target: TestApp, headers: Record<string, string>, email = 'alice@example.com') {
  return target.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
    headers,
  })
}

async function sessionCount(): Promise<number> {
  const { rows } = await database.db.execute<{ count: number }>(
    sql`select count(*)::int as count from sessions`,
  )
  return rows[0]?.count ?? 0
}

describe('CSRF guard (cookie-authenticated unsafe methods)', () => {
  let target: TestApp

  beforeEach(async () => {
    target = await buildTestApp()
    app = target
    await register(target, 'alice@example.com')
  })

  it('accepts the allowed dashboard origins', async () => {
    expect((await loginWith(target, { origin: 'http://localhost:5173' })).statusCode).toBe(200)
    expect((await loginWith(target, { origin: 'http://localhost:4173' })).statusCode).toBe(200)
  })

  it('rejects a foreign origin before any work is done', async () => {
    const before = await sessionCount()

    const response = await loginWith(target, { origin: 'https://evil.example' })

    expect(response.statusCode).toBe(403)
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('FORBIDDEN')
    expect(await sessionCount()).toBe(before)
  })

  it('rejects an opaque origin (Origin: null)', async () => {
    expect((await loginWith(target, { origin: 'null' })).statusCode).toBe(403)
  })

  it('accepts same-origin requests identified only by Sec-Fetch-Site', async () => {
    expect((await loginWith(target, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200)
  })

  it('rejects cross-site, same-site and user-initiated (none) requests without Origin', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect((await loginWith(target, { 'sec-fetch-site': site })).statusCode).toBe(403)
    }
  })

  it('lets non-browser clients through (no Origin, no Sec-Fetch-Site)', async () => {
    expect((await loginWith(target, {})).statusCode).toBe(200)
  })

  it('protects logout too, and leaves the session valid when it blocks', async () => {
    const { cookie } = await register(target, 'bob@example.com')

    const forged = await target.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: 'https://evil.example' },
    })
    const stillValid = await target.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie, origin: 'https://evil.example' },
    })

    expect(forged.statusCode).toBe(403)
    // GET is a safe method: never blocked, even with a foreign Origin.
    expect(stillValid.statusCode).toBe(200)
  })

  it('ignores the session cookie on bearer requests', async () => {
    const { cookie } = await register(target, 'carol@example.com')

    const response = await target.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie, authorization: 'Bearer not-a-real-token' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses text/plain bodies, which a cross-site form could send without a preflight', async () => {
    const response = await target.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ email: 'alice@example.com', password: PASSWORD }),
    })

    expect(response.statusCode).toBe(415)
  })
})

describe('auth rate limits', () => {
  it('limits login attempts per client and account, then answers 429 with retry-after', async () => {
    app = await buildTestApp({
      config: { rateLimits: { windowMs: 60_000, loginMax: 3, registerMax: 20 } },
    })
    await register(app, 'alice@example.com')
    const attempt = (target: TestApp, email: string, password: string) =>
      target.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } })

    for (let i = 0; i < 3; i++) {
      expect((await attempt(app, 'alice@example.com', 'wrong password!')).statusCode).toBe(401)
    }
    const limited = await attempt(app, 'alice@example.com', PASSWORD)
    const otherAccount = await attempt(app, 'bob@example.com', 'wrong password!')

    expect(limited.statusCode).toBe(429)
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe('RATE_LIMITED')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(sessionCookie(limited)).toBeUndefined()
    // The key includes the email: another account from the same client is unaffected.
    expect(otherAccount.statusCode).toBe(401)
  })

  it('limits registrations per client', async () => {
    app = await buildTestApp({
      config: { rateLimits: { windowMs: 60_000, loginMax: 10, registerMax: 2 } },
    })

    await register(app, 'one@example.com')
    await register(app, 'two@example.com')
    const third = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'three@example.com', password: PASSWORD, displayName: 'Three' },
    })

    expect(third.statusCode).toBe(429)
    expect(apiErrorSchema.parse(third.json()).error.code).toBe('RATE_LIMITED')
  })
})
