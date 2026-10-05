import { createHash } from 'node:crypto'

import { apiErrorSchema, sessionResponseSchema } from '@contextlayer/shared'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildTestApp,
  controllableClock,
  cookieHeader,
  PASSWORD,
  register,
  sessionCookie,
  type TestApp,
} from './support/app.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp | undefined

afterAll(() => database.close())
beforeEach(() => resetTestDatabase(database))
afterEach(async () => {
  await app?.close()
  app = undefined
})

async function login(target: TestApp, email: string, password: string, cookie?: string) {
  return target.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
    ...(cookie && { headers: { cookie } }),
  })
}

async function currentSession(target: TestApp, cookie: string) {
  return target.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })
}

describe('POST /v1/auth/register', () => {
  it('creates the account, starts a session and sets a hardened cookie', async () => {
    app = await buildTestApp()

    const { response } = await register(app, 'alice@example.com', 'Alice')

    const body = sessionResponseSchema.parse(response.json())
    expect(body.user).toMatchObject({ email: 'alice@example.com', displayName: 'Alice' })
    expect(body.workspaces).toEqual([])
    expect(response.body).not.toMatch(/password|hash|token/i)
    expect(sessionCookie(response)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 8 * 3600,
    })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('stores an argon2id hash and the SHA-256 of the session token, never the secrets', async () => {
    app = await buildTestApp()

    const { response } = await register(app, 'alice@example.com')

    const token = sessionCookie(response)?.value ?? ''
    const { rows: users } = await database.db.execute<{ password_hash: string }>(
      sql`select password_hash from users`,
    )
    const { rows: sessions } = await database.db.execute<{ token_hash: Buffer }>(
      sql`select token_hash from sessions`,
    )
    expect(users[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(users[0]?.password_hash).not.toContain(PASSWORD)
    expect(sessions[0]?.token_hash.equals(createHash('sha256').update(token).digest())).toBe(true)
    expect(sessions[0]?.token_hash.toString()).not.toContain(token)
  })

  it('rejects an email that is already registered, whatever its case', async () => {
    app = await buildTestApp()
    await register(app, 'alice@example.com')

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'ALICE@example.com', password: PASSWORD, displayName: 'Alice 2' },
    })

    expect(response.statusCode).toBe(409)
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('CONFLICT')
  })

  it('validates input: email format and minimum password length', async () => {
    app = await buildTestApp()

    for (const payload of [
      { email: 'not-an-email', password: PASSWORD, displayName: 'X' },
      { email: 'bob@example.com', password: 'too-short', displayName: 'X' },
      { email: 'bob@example.com', password: PASSWORD, displayName: '   ' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/register', payload })
      expect(response.statusCode).toBe(400)
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('VALIDATION_FAILED')
    }
  })
})

describe('POST /v1/auth/login', () => {
  it('issues a new session for the right password', async () => {
    app = await buildTestApp()
    const registered = await register(app, 'alice@example.com')

    const response = await login(app, 'Alice@Example.com', PASSWORD)

    expect(response.statusCode).toBe(200)
    expect(sessionResponseSchema.parse(response.json()).user.email).toBe('alice@example.com')
    expect(cookieHeader(response)).not.toBe(registered.cookie)
  })

  it('answers wrong password and unknown email identically (no enumeration)', async () => {
    app = await buildTestApp()
    await register(app, 'alice@example.com')

    const wrongPassword = await login(app, 'alice@example.com', 'not the password at all')
    const unknownEmail = await login(app, 'nobody@example.com', PASSWORD)

    for (const response of [wrongPassword, unknownEmail]) {
      expect(response.statusCode).toBe(401)
      expect(apiErrorSchema.parse(response.json()).error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password.',
      })
      expect(sessionCookie(response)).toBeUndefined()
    }
  })

  it('revokes the session the client already had (no session fixation)', async () => {
    app = await buildTestApp()
    const registered = await register(app, 'alice@example.com')

    await login(app, 'alice@example.com', PASSWORD, registered.cookie)

    expect((await currentSession(app, registered.cookie)).statusCode).toBe(401)
  })
})

describe('sessions', () => {
  it('GET /v1/auth/session returns the identity for a valid cookie and 401 otherwise', async () => {
    app = await buildTestApp()
    const { cookie } = await register(app, 'alice@example.com')

    const valid = await currentSession(app, cookie)
    const missing = await app.inject({ method: 'GET', url: '/v1/auth/session' })
    const forged = await currentSession(app, `cl_session=${'A'.repeat(43)}`)

    expect(valid.statusCode).toBe(200)
    expect(sessionResponseSchema.parse(valid.json()).user.email).toBe('alice@example.com')
    expect(missing.statusCode).toBe(401)
    expect(forged.statusCode).toBe(401)
    // An unusable cookie is cleared, so the browser stops sending it.
    expect(sessionCookie(forged)?.maxAge).toBe(0)
  })

  it('logout revokes the session and clears the cookie', async () => {
    app = await buildTestApp()
    const { cookie } = await register(app, 'alice@example.com')

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(204)
    expect(sessionCookie(response)).toMatchObject({ value: '', maxAge: 0 })
    expect((await currentSession(app, cookie)).statusCode).toBe(401)
    const { rows } = await database.db.execute<{ revoked: boolean }>(
      sql`select revoked_at is not null as revoked from sessions`,
    )
    expect(rows).toEqual([{ revoked: true }])
  })

  it('expires after 30 minutes of inactivity', async () => {
    const clock = controllableClock()
    app = await buildTestApp({ now: clock.now })
    const { cookie } = await register(app, 'alice@example.com')

    clock.advance(29 * 60_000)
    expect((await currentSession(app, cookie)).statusCode).toBe(200)
    clock.advance(31 * 60_000)

    expect((await currentSession(app, cookie)).statusCode).toBe(401)
  })

  it('expires 8 hours after sign-in even when used continuously', async () => {
    const clock = controllableClock()
    app = await buildTestApp({ now: clock.now })
    const { cookie } = await register(app, 'alice@example.com')

    for (let elapsed = 0; elapsed < 7.9 * 60; elapsed += 20) {
      clock.advance(20 * 60_000)
      if (elapsed + 20 < 8 * 60) expect((await currentSession(app, cookie)).statusCode).toBe(200)
    }
    clock.advance(20 * 60_000)

    expect((await currentSession(app, cookie)).statusCode).toBe(401)
  })

  it('rejects a session revoked directly in the database', async () => {
    app = await buildTestApp()
    const { cookie } = await register(app, 'alice@example.com')

    await database.db.execute(sql`update sessions set revoked_at = now()`)

    expect((await currentSession(app, cookie)).statusCode).toBe(401)
  })
})
