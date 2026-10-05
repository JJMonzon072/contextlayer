import { connectionListSchema } from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildTestApp,
  controllableClock,
  cookieHeader,
  PASSWORD,
  register,
  type TestApp,
} from './support/app.js'
import { addMember, createWorkspace } from './support/content.js'
import { bearer, connect } from './support/extension.js'
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

const list = (cookie: string) =>
  app.inject({ method: 'GET', url: '/v1/extension/connections', headers: { cookie } })
const revoke = (cookie: string, id: string, origin = 'http://localhost:5173') =>
  app.inject({
    method: 'DELETE',
    url: `/v1/extension/connections/${id}`,
    headers: { cookie, origin },
  })

/** Alice owns Acme and Globex; Bob is a member of Acme. Both connect browsers. */
async function setup() {
  const alice = await register(app, 'alice@example.test', 'Alice')
  const bob = await register(app, 'bob@example.test', 'Bob')
  const acme = await createWorkspace(app, alice.cookie, 'Acme')
  const globex = await createWorkspace(app, alice.cookie, 'Globex')
  await addMember(app, alice.cookie, acme.id, 'bob@example.test', 'member')
  const aliceAcme = await connect(app, alice.cookie, acme.id)
  const aliceGlobex = await connect(app, alice.cookie, globex.id)
  const bobAcme = await connect(app, bob.cookie, acme.id)
  return { alice, bob, acme, globex, aliceAcme, aliceGlobex, bobAcme }
}

describe('connected browsers', () => {
  it('lists only the caller own connections, across workspaces, without credentials', async () => {
    const { alice, aliceAcme, aliceGlobex, bobAcme } = await setup()

    const response = await list(alice.cookie)

    expect(response.statusCode).toBe(200)
    const { items } = connectionListSchema.parse(response.json())
    expect(items.map((item) => item.id).sort()).toEqual(
      [aliceAcme.connection.id, aliceGlobex.connection.id].sort(),
    )
    expect(items.map((item) => item.workspace.name).sort()).toEqual(['Acme', 'Globex'])
    expect(items.every((item) => item.status === 'active')).toBe(true)
    expect(response.body).not.toContain(bobAcme.connection.id)
    expect(response.body).not.toMatch(/cla_|clr_|clc_|hash/i)
  })

  it('revokes a connection, effective on its next request', async () => {
    const { alice, aliceAcme } = await setup()

    expect((await revoke(alice.cookie, aliceAcme.connection.id)).statusCode).toBe(204)

    expect((await bearer(app, '/v1/extension/session', aliceAcme.accessToken)).statusCode).toBe(401)
    const { items } = connectionListSchema.parse((await list(alice.cookie)).json())
    expect(items.find((item) => item.id === aliceAcme.connection.id)).toMatchObject({
      status: 'revoked',
      revokedReason: 'dashboard',
    })
  })

  it("cannot revoke another user's connection, even in a shared workspace", async () => {
    const { alice, bobAcme } = await setup()

    expect((await revoke(alice.cookie, bobAcme.connection.id)).statusCode).toBe(404)
    expect((await bearer(app, '/v1/extension/session', bobAcme.accessToken)).statusCode).toBe(200)
  })

  it('keeps the dashboard and extension credentials apart', async () => {
    const { alice, aliceAcme } = await setup()

    const listWithBearer = await app.inject({
      method: 'GET',
      url: '/v1/extension/connections',
      headers: { authorization: `Bearer ${aliceAcme.accessToken}` },
    })
    const crossSite = await revoke(alice.cookie, aliceAcme.connection.id, 'https://evil.example')

    expect(listWithBearer.statusCode).toBe(401)
    expect(crossSite.statusCode).toBe(403)
    expect((await bearer(app, '/v1/extension/session', aliceAcme.accessToken)).statusCode).toBe(200)
  })

  it('shows expired connections as expired', async () => {
    await setup()
    clock.advance(31 * 86_400_000)
    // The dashboard session expired too (8 h): sign in again.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'alice@example.test', password: PASSWORD },
    })

    const { items } = connectionListSchema.parse((await list(cookieHeader(login))).json())

    expect(items.every((item) => item.status === 'expired')).toBe(true)
  })
})
