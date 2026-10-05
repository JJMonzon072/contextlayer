import {
  apiErrorSchema,
  connectionCodeSchema,
  extensionConnectionInfoSchema,
  extensionTokenResponseSchema,
} from '@contextlayer/shared'
import { eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  extensionAccessTokens,
  extensionAuthCodes,
  extensionGrants,
  extensionRefreshTokens,
  workspaceMembers,
} from '../../src/infrastructure/database/schema.js'
import { buildTestApp, controllableClock, register, type TestApp } from './support/app.js'
import { addMember, createWorkspace } from './support/content.js'
import { bearer, connect, exchange, issueCode, pkcePair, postToken } from './support/extension.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp
let clock: ReturnType<typeof controllableClock>

afterAll(() => database.close())
beforeEach(async () => {
  await resetTestDatabase(database)
  clock = controllableClock(new Date('2026-10-05T12:00:00Z'))
  app = await buildTestApp({ now: clock.now })
})
afterEach(() => app.close())

async function owner() {
  const alice = await register(app, 'alice@example.test', 'Alice')
  const workspace = await createWorkspace(app, alice.cookie, 'Acme')
  return { ...alice, workspaceId: workspace.id }
}

describe('connection codes (dashboard)', () => {
  it('are issued to a signed-in member for 60 seconds', async () => {
    const alice = await owner()
    const response = await issueCode(
      alice.cookie ? app : app,
      alice.cookie,
      alice.workspaceId,
      pkcePair().challenge,
    )

    expect(response.statusCode).toBe(201)
    const code = connectionCodeSchema.parse(response.json())
    expect(code.code).toMatch(/^clc_/)
    expect(new Date(code.expiresAt).getTime() - clock.now().getTime()).toBe(60_000)
  })

  it('need a session, pass the CSRF guard, and a workspace of the caller', async () => {
    const alice = await owner()
    const bob = await register(app, 'bob@example.test', 'Bob')
    const { challenge } = pkcePair()

    const anonymous = await app.inject({
      method: 'POST',
      url: '/v1/extension/codes',
      payload: {
        workspaceId: alice.workspaceId,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      },
    })
    const crossSite = await app.inject({
      method: 'POST',
      url: '/v1/extension/codes',
      headers: { cookie: alice.cookie, origin: 'https://evil.example' },
      payload: {
        workspaceId: alice.workspaceId,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      },
    })
    const foreign = await issueCode(app, bob.cookie, alice.workspaceId, challenge)

    expect(anonymous.statusCode).toBe(401)
    expect(crossSite.statusCode).toBe(403)
    expect(foreign.statusCode).toBe(404)
    expect(await database.db.select().from(extensionAuthCodes)).toEqual([])
  })

  it('accept S256 challenges only and refuse unknown fields', async () => {
    const alice = await owner()
    const { verifier, challenge } = pkcePair()

    expect(
      (
        await issueCode(app, alice.cookie, alice.workspaceId, challenge, {
          codeChallengeMethod: 'plain',
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await issueCode(app, alice.cookie, alice.workspaceId, verifier.slice(0, 20))).statusCode,
    ).toBe(400)
    expect(
      (await issueCode(app, alice.cookie, alice.workspaceId, challenge, { userId: alice.userId }))
        .statusCode,
    ).toBe(400)
  })
})

describe('code exchange (token endpoint)', () => {
  it('creates a 30-day grant with a 15-minute access token and stores hashes only', async () => {
    const alice = await owner()

    const tokens = await connect(app, alice.cookie, alice.workspaceId)

    expect(tokens.accessToken).toMatch(/^cla_/)
    expect(tokens.refreshToken).toMatch(/^clr_/)
    expect(new Date(tokens.accessTokenExpiresAt).getTime() - clock.now().getTime()).toBe(
      15 * 60_000,
    )
    expect(tokens.connection).toMatchObject({
      label: 'Chrome extension',
      user: { displayName: 'Alice', email: 'alice@example.test' },
      workspace: { id: alice.workspaceId, name: 'Acme' },
    })
    const [grant] = await database.db.select().from(extensionGrants)
    expect(grant?.expiresAt.getTime()).toBe(clock.now().getTime() + 30 * 86_400_000)
    const stored = JSON.stringify([
      await database.db.select().from(extensionAccessTokens),
      await database.db.select().from(extensionRefreshTokens),
      await database.db.select().from(extensionAuthCodes),
    ])
    for (const secret of [tokens.accessToken, tokens.refreshToken]) {
      expect(stored).not.toContain(secret.slice(4))
    }
  })

  it('is accepted from the service worker origin without a cookie or bearer token', async () => {
    const alice = await owner()
    const { verifier, challenge } = pkcePair()
    const { code } = (await issueCode(app, alice.cookie, alice.workspaceId, challenge)).json<{
      code: string
    }>()

    // Origin chrome-extension://<id> and Sec-Fetch-Site: none, as measured in the spike.
    const response = await postToken(
      app,
      {
        grantType: 'authorization_code',
        code,
        codeVerifier: verifier,
        clientId: 'ebdclkadgcmjipockfofmlakcfijojko',
      },
      { 'sec-fetch-site': 'none' },
    )

    expect(response.statusCode).toBe(200)
  })

  it('refuses a wrong verifier, and the code cannot be retried', async () => {
    const alice = await owner()
    const { verifier, challenge } = pkcePair()
    const { code } = (await issueCode(app, alice.cookie, alice.workspaceId, challenge)).json<{
      code: string
    }>()

    const wrong = await exchange(app, code, pkcePair().verifier)
    const retry = await exchange(app, code, verifier)

    expect(wrong.statusCode).toBe(400)
    expect(retry.statusCode).toBe(400)
    expect(await database.db.select().from(extensionGrants)).toEqual([])
  })

  it('refuses an expired code, another client id and the challenge used as verifier', async () => {
    const alice = await owner()
    const codes = await Promise.all(
      [0, 1, 2].map(async () => {
        const pair = pkcePair()
        const issued = await issueCode(app, alice.cookie, alice.workspaceId, pair.challenge)
        return { ...pair, code: issued.json<{ code: string }>().code }
      }),
    )
    const [expired, otherClient, plain] = codes
    if (!expired || !otherClient || !plain) throw new Error('missing codes')

    expect(
      (await exchange(app, otherClient.code, otherClient.verifier, 'a'.repeat(32))).statusCode,
    ).toBe(400)
    expect((await exchange(app, plain.code, plain.challenge)).statusCode).toBe(400)
    clock.advance(61_000)
    expect((await exchange(app, expired.code, expired.verifier)).statusCode).toBe(400)
  })

  it('revokes the grant it created when a consumed code is replayed', async () => {
    const alice = await owner()
    const { verifier, challenge } = pkcePair()
    const { code } = (await issueCode(app, alice.cookie, alice.workspaceId, challenge)).json<{
      code: string
    }>()
    const first = extensionTokenResponseSchema.parse((await exchange(app, code, verifier)).json())

    const replay = await exchange(app, code, verifier)

    expect(replay.statusCode).toBe(400)
    const [grant] = await database.db.select().from(extensionGrants)
    expect(grant).toMatchObject({ revokedReason: 'code-replay' })
    expect((await bearer(app, '/v1/extension/session', first.accessToken)).statusCode).toBe(401)
  })

  it('never creates two grants from two concurrent exchanges of one code', async () => {
    const alice = await owner()
    const { verifier, challenge } = pkcePair()
    const { code } = (await issueCode(app, alice.cookie, alice.workspaceId, challenge)).json<{
      code: string
    }>()

    const responses = await Promise.all([
      exchange(app, code, verifier),
      exchange(app, code, verifier),
    ])

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400])
    expect(await database.db.select().from(extensionGrants)).toHaveLength(1)
  })

  it('checks the membership again: a member removed after issuance gets nothing', async () => {
    const alice = await owner()
    const bob = await register(app, 'bob@example.test', 'Bob')
    await addMember(app, alice.cookie, alice.workspaceId, 'bob@example.test', 'member')
    const { verifier, challenge } = pkcePair()
    const { code } = (await issueCode(app, bob.cookie, alice.workspaceId, challenge)).json<{
      code: string
    }>()

    await database.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, bob.userId))
    await addMember(app, alice.cookie, alice.workspaceId, 'bob@example.test', 'member')

    expect((await exchange(app, code, verifier)).statusCode).toBe(400)
    expect(await database.db.select().from(extensionGrants)).toEqual([])
  })

  it('answers every refusal with the same message', async () => {
    const response = await exchange(app, `clc_${'A'.repeat(43)}`, pkcePair().verifier)

    expect(apiErrorSchema.parse(response.json()).error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The connection code or refresh token is invalid, expired or already used.',
    })
  })
})

describe('extension access tokens', () => {
  it('authenticate the session route, and only as bearer tokens', async () => {
    const alice = await owner()
    const tokens = await connect(app, alice.cookie, alice.workspaceId)

    const ok = await bearer(app, '/v1/extension/session', tokens.accessToken)
    const none = await app.inject({ method: 'GET', url: '/v1/extension/session' })
    const cookieOnly = await app.inject({
      method: 'GET',
      url: '/v1/extension/session',
      headers: { cookie: alice.cookie },
    })
    const refreshAsAccess = await bearer(app, '/v1/extension/session', tokens.refreshToken)

    expect(ok.statusCode).toBe(200)
    expect(extensionConnectionInfoSchema.parse(ok.json()).workspace.name).toBe('Acme')
    expect(none.statusCode).toBe(401)
    expect(none.headers['www-authenticate']).toBe('Bearer realm="contextlayer-extension"')
    expect(cookieOnly.statusCode).toBe(401)
    expect(refreshAsAccess.statusCode).toBe(401)
  })

  it('never fall back to a valid cookie when the bearer token is invalid', async () => {
    const alice = await owner()

    const response = await app.inject({
      method: 'GET',
      url: '/v1/extension/session',
      headers: { cookie: alice.cookie, authorization: `Bearer cla_${'A'.repeat(43)}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toContain('invalid_token')
  })

  it('cannot reach cookie routes: any Authorization header makes them refuse', async () => {
    const alice = await owner()
    const tokens = await connect(app, alice.cookie, alice.workspaceId)

    const withBearer = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: alice.cookie, authorization: `Bearer ${tokens.accessToken}` },
    })
    const withBasic = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie: alice.cookie, authorization: 'Basic YTpi' },
    })

    expect(withBearer.statusCode).toBe(401)
    expect(withBasic.statusCode).toBe(401)
  })

  it('expire after 15 minutes', async () => {
    const alice = await owner()
    const tokens = await connect(app, alice.cookie, alice.workspaceId)

    clock.advance(15 * 60_000)

    expect((await bearer(app, '/v1/extension/session', tokens.accessToken)).statusCode).toBe(401)
  })

  it('stop working as soon as the member leaves the workspace', async () => {
    const alice = await owner()
    const bob = await register(app, 'bob@example.test', 'Bob')
    await addMember(app, alice.cookie, alice.workspaceId, 'bob@example.test', 'member')
    const tokens = await connect(app, bob.cookie, alice.workspaceId)

    await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${alice.workspaceId}/members/${bob.userId}`,
      headers: { cookie: bob.cookie },
    })

    expect((await bearer(app, '/v1/extension/session', tokens.accessToken)).statusCode).toBe(401)
  })
})

describe('secrets in logs', () => {
  it('never logs codes, verifiers or tokens', async () => {
    const lines: string[] = []
    await app.close()
    app = await buildTestApp({
      now: clock.now,
      logger: pino({ level: 'trace' }, { write: (line: string) => lines.push(line) }),
    })
    const alice = await owner()
    const { verifier, challenge } = pkcePair()
    const { code } = (await issueCode(app, alice.cookie, alice.workspaceId, challenge)).json<{
      code: string
    }>()
    const tokens = extensionTokenResponseSchema.parse((await exchange(app, code, verifier)).json())
    await bearer(app, '/v1/extension/session', tokens.accessToken)
    await exchange(app, code, verifier)

    const log = lines.join('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const secret of [code, verifier, tokens.accessToken, tokens.refreshToken]) {
      expect(log).not.toContain(secret.slice(4))
    }
  })
})
