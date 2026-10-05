import { extensionTokenResponseSchema, type ExtensionTokenResponse } from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  extensionGrants,
  extensionRefreshTokens,
} from '../../src/infrastructure/database/schema.js'
import { buildTestApp, controllableClock, register, type TestApp } from './support/app.js'
import { addMember, createWorkspace } from './support/content.js'
import { bearer, connect, pkcePair, postToken } from './support/extension.js'
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

async function connected(): Promise<{
  cookie: string
  workspaceId: string
  tokens: ExtensionTokenResponse
}> {
  const alice = await register(app, 'alice@example.test', 'Alice')
  const workspace = await createWorkspace(app, alice.cookie, 'Acme')
  return {
    cookie: alice.cookie,
    workspaceId: workspace.id,
    tokens: await connect(app, alice.cookie, workspace.id),
  }
}

const refresh = (refreshToken: string) =>
  postToken(app, { grantType: 'refresh_token', refreshToken })
const session = (accessToken: string) => bearer(app, '/v1/extension/session', accessToken)
const grants = () => database.db.select().from(extensionGrants)

describe('refresh rotation', () => {
  it('trades a refresh token for a new pair, once', async () => {
    const { tokens } = await connected()
    clock.advance(10 * 60_000)

    const response = await refresh(tokens.refreshToken)

    expect(response.statusCode).toBe(200)
    const next = extensionTokenResponseSchema.parse(response.json())
    expect(next.refreshToken).not.toBe(tokens.refreshToken)
    expect(next.accessToken).not.toBe(tokens.accessToken)
    expect((await session(next.accessToken)).statusCode).toBe(200)
    const chain = await database.db.select().from(extensionRefreshTokens)
    expect(chain).toHaveLength(2)
    expect(chain.find((row) => row.parentId !== null)?.parentId).toBe(
      chain.find((row) => row.parentId === null)?.id,
    )
  })

  it('revokes the grant when a used refresh token comes back, and keeps it revoked', async () => {
    const { tokens } = await connected()
    const next = extensionTokenResponseSchema.parse((await refresh(tokens.refreshToken)).json())

    const reuse = await refresh(tokens.refreshToken)

    expect(reuse.statusCode).toBe(400)
    // The error response did not roll the revocation back.
    expect((await grants())[0]).toMatchObject({ revokedReason: 'refresh-reuse' })
    expect((await session(next.accessToken)).statusCode).toBe(401)
    expect((await refresh(next.refreshToken)).statusCode).toBe(400)
  })

  it('leaves no two live chains when two refreshes race with the same token', async () => {
    const { tokens } = await connected()

    const responses = await Promise.all([
      refresh(tokens.refreshToken),
      refresh(tokens.refreshToken),
    ])

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400])
    const winner = extensionTokenResponseSchema.parse(
      responses.find((r) => r.statusCode === 200)?.json(),
    )
    // Strict policy: the second use is reuse, so the whole grant is revoked.
    expect((await grants())[0]).toMatchObject({ revokedReason: 'refresh-reuse' })
    expect((await session(winner.accessToken)).statusCode).toBe(401)
    expect(await database.db.select().from(extensionRefreshTokens)).toHaveLength(2)
  })

  it('cannot undo a revocation with a refresh racing it', async () => {
    const { tokens } = await connected()

    await Promise.all([
      refresh(tokens.refreshToken),
      bearer(app, '/v1/extension/revoke', tokens.accessToken, 'POST'),
    ])

    expect((await grants())[0]?.revokedAt).not.toBeNull()
    expect((await session(tokens.accessToken)).statusCode).toBe(401)
    const newest = await database.db.select().from(extensionRefreshTokens)
    expect(newest.length).toBeLessThanOrEqual(2)
  })

  it('never extends the 30-day limit of the connection', async () => {
    const { tokens } = await connected()
    const [grant] = await grants()
    clock.advance(30 * 86_400_000 - 5 * 60_000)

    const late = extensionTokenResponseSchema.parse((await refresh(tokens.refreshToken)).json())

    expect(new Date(late.accessTokenExpiresAt).getTime()).toBe(grant?.expiresAt.getTime())
    clock.advance(5 * 60_000)
    expect((await refresh(late.refreshToken)).statusCode).toBe(400)
    expect((await session(late.accessToken)).statusCode).toBe(401)
  })

  it('stops when the member leaves the workspace', async () => {
    const alice = await register(app, 'alice@example.test', 'Alice')
    const workspace = await createWorkspace(app, alice.cookie, 'Acme')
    const bob = await register(app, 'bob@example.test', 'Bob')
    await addMember(app, alice.cookie, workspace.id, 'bob@example.test', 'member')
    const tokens = await connect(app, bob.cookie, workspace.id)

    await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspace.id}/members/${bob.userId}`,
      headers: { cookie: alice.cookie, origin: 'http://localhost:5173' },
    })

    expect((await refresh(tokens.refreshToken)).statusCode).toBe(400)
  })

  it('does not accept other credential types as refresh tokens', async () => {
    const { tokens } = await connected()

    expect((await refresh(tokens.accessToken)).statusCode).toBe(400)
    expect(
      (
        await postToken(app, {
          grantType: 'refresh_token',
          refreshToken: tokens.refreshToken,
          extra: 1,
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await postToken(app, { grantType: 'password', refreshToken: tokens.refreshToken }))
        .statusCode,
    ).toBe(400)
  })
})

describe('revocation by the extension', () => {
  it('ends the connection for every token of the grant', async () => {
    const { tokens } = await connected()

    const revoked = await bearer(app, '/v1/extension/revoke', tokens.accessToken, 'POST')

    expect(revoked.statusCode).toBe(204)
    expect((await grants())[0]).toMatchObject({ revokedReason: 'disconnected' })
    expect((await session(tokens.accessToken)).statusCode).toBe(401)
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(400)
  })

  it('needs a bearer access token', async () => {
    const { cookie } = await connected()

    expect((await app.inject({ method: 'POST', url: '/v1/extension/revoke' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'POST', url: '/v1/extension/revoke', headers: { cookie } }))
        .statusCode,
    ).toBe(401)
  })
})

describe('token endpoint rate limit', () => {
  it('limits exchanges and refreshes per client address', async () => {
    await app.close()
    app = await buildTestApp({
      now: clock.now,
      config: {
        rateLimits: {
          windowMs: 60_000,
          loginMax: 10,
          registerMax: 20,
          extensionTokenMax: 3,
          extensionCodeMax: 30,
        },
      },
    })
    const attempt = () =>
      postToken(app, {
        grantType: 'authorization_code',
        code: `clc_${'A'.repeat(43)}`,
        codeVerifier: pkcePair().verifier,
        clientId: 'ebdclkadgcmjipockfofmlakcfijojko',
      })

    const statuses = []
    for (let index = 0; index < 4; index += 1) statuses.push((await attempt()).statusCode)
    const limited = await attempt()

    expect(statuses).toEqual([400, 400, 400, 429])
    expect(limited.headers['retry-after']).toBeDefined()
  })
})

describe('revocation reasons', () => {
  it('records a replaced connection as replaced', async () => {
    const { tokens } = await connected()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/extension/revoke',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { reason: 'replaced' },
    })

    expect(response.statusCode).toBe(204)
    expect((await grants())[0]).toMatchObject({ revokedReason: 'replaced' })
  })

  it('accepts only the reasons an extension may give', async () => {
    const { tokens } = await connected()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/extension/revoke',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { reason: 'refresh-reuse' },
    })

    expect(response.statusCode).toBe(400)
    expect((await grants())[0]?.revokedAt).toBeNull()
  })
})
