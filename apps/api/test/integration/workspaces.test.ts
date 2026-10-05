import { randomUUID } from 'node:crypto'

import {
  apiErrorSchema,
  memberListSchema,
  sessionResponseSchema,
  workspaceListSchema,
  workspaceSummarySchema,
} from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, register, type TestApp } from './support/app.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp

afterAll(() => database.close())
beforeEach(async () => {
  await resetTestDatabase(database)
  app = await buildTestApp()
})
afterEach(() => app.close())

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    ...(cookie && { headers: { cookie } }),
    ...(payload && { payload }),
  })
}

async function createWorkspace(cookie: string, name: string) {
  const response = await call('POST', '/v1/workspaces', cookie, { name })
  expect(response.statusCode).toBe(201)
  return workspaceSummarySchema.parse(response.json())
}

async function addMember(cookie: string, workspaceId: string, email: string, role: string) {
  return call('POST', `/v1/workspaces/${workspaceId}/members`, cookie, { email, role })
}

/**
 * Two tenants: A (owner, member, and `targetA`, the member the matrix tries to
 * change or remove) and B (owner), plus a user with no workspace.
 */
async function twoTenants() {
  const ownerA = await register(app, 'owner-a@example.com', 'Owner A')
  const memberA = await register(app, 'member-a@example.com', 'Member A')
  const targetA = await register(app, 'target-a@example.com', 'Target A')
  const ownerB = await register(app, 'owner-b@example.com', 'Owner B')
  const outsider = await register(app, 'outsider@example.com', 'Outsider')
  await register(app, 'newcomer@example.com', 'Newcomer')
  const workspaceA = await createWorkspace(ownerA.cookie, 'Acme')
  const workspaceB = await createWorkspace(ownerB.cookie, 'Globex')
  expect(
    (await addMember(ownerA.cookie, workspaceA.id, 'member-a@example.com', 'member')).statusCode,
  ).toBe(201)
  expect(
    (await addMember(ownerA.cookie, workspaceA.id, 'target-a@example.com', 'member')).statusCode,
  ).toBe(201)
  return { ownerA, memberA, targetA, ownerB, outsider, workspaceA, workspaceB }
}

describe('tenant isolation matrix (workspace A)', () => {
  type Actor = 'ownerOfA' | 'memberOfA' | 'userOfB' | 'noMembership' | 'anonymous'
  const expectations: Record<
    Actor,
    [read: number, members: number, add: number, patch: number, remove: number]
  > = {
    ownerOfA: [200, 200, 201, 200, 204],
    memberOfA: [200, 200, 403, 403, 403],
    // Not a member: 404, exactly like a workspace that does not exist.
    userOfB: [404, 404, 404, 404, 404],
    noMembership: [404, 404, 404, 404, 404],
    anonymous: [401, 401, 401, 401, 401],
  }

  it.each(Object.entries(expectations) as [Actor, number[]][])(
    '%s gets %j for read, members, add, change role, remove',
    async (actor, expected) => {
      const tenants = await twoTenants()
      const cookies: Record<Actor, string | undefined> = {
        ownerOfA: tenants.ownerA.cookie,
        memberOfA: tenants.memberA.cookie,
        userOfB: tenants.ownerB.cookie,
        noMembership: tenants.outsider.cookie,
        anonymous: undefined,
      }
      const cookie = cookies[actor]
      const base = `/v1/workspaces/${tenants.workspaceA.id}`

      const statuses = [
        (await call('GET', base, cookie)).statusCode,
        (await call('GET', `${base}/members`, cookie)).statusCode,
        (
          await call('POST', `${base}/members`, cookie, {
            email: 'newcomer@example.com',
            role: 'editor',
          })
        ).statusCode,
        (
          await call('PATCH', `${base}/members/${tenants.targetA.userId}`, cookie, {
            role: 'editor',
          })
        ).statusCode,
        (await call('DELETE', `${base}/members/${tenants.targetA.userId}`, cookie)).statusCode,
      ]

      expect(statuses).toEqual(expected)
    },
  )

  it("lists only the caller's own workspaces", async () => {
    const tenants = await twoTenants()

    const forB = workspaceListSchema.parse(
      (await call('GET', '/v1/workspaces', tenants.ownerB.cookie)).json(),
    )
    const forMemberA = workspaceListSchema.parse(
      (await call('GET', '/v1/workspaces', tenants.memberA.cookie)).json(),
    )

    expect(forB.items.map((w) => w.name)).toEqual(['Globex'])
    expect(forMemberA.items).toEqual([expect.objectContaining({ name: 'Acme', role: 'member' })])
  })

  it('answers a foreign workspace exactly like a missing one', async () => {
    const tenants = await twoTenants()

    const foreign = await call(
      'GET',
      `/v1/workspaces/${tenants.workspaceA.id}`,
      tenants.ownerB.cookie,
    )
    const missing = await call('GET', `/v1/workspaces/${randomUUID()}`, tenants.ownerB.cookie)

    expect(foreign.statusCode).toBe(404)
    expect(missing.statusCode).toBe(404)
    const { requestId: _a, ...foreignError } = apiErrorSchema.parse(foreign.json()).error
    const { requestId: _b, ...missingError } = apiErrorSchema.parse(missing.json()).error
    expect(foreignError).toEqual(missingError)
  })

  it('rejects malformed workspace ids before any query', async () => {
    const { ownerA } = await twoTenants()

    const response = await call('GET', '/v1/workspaces/not-a-uuid', ownerA.cookie)

    expect(response.statusCode).toBe(400)
  })
})

describe('workspaces', () => {
  it('creates a workspace owned by the caller and exposes it in the session', async () => {
    const alice = await register(app, 'alice@example.com', 'Alice')

    const workspace = await createWorkspace(alice.cookie, '  Acme Support  ')
    const session = sessionResponseSchema.parse(
      (await call('GET', '/v1/auth/session', alice.cookie)).json(),
    )

    expect(workspace).toMatchObject({ name: 'Acme Support', role: 'owner' })
    expect(session.workspaces).toEqual([workspace])
  })

  it('validates the workspace name', async () => {
    const alice = await register(app, 'alice@example.com')

    expect((await call('POST', '/v1/workspaces', alice.cookie, { name: '   ' })).statusCode).toBe(
      400,
    )
    expect(
      (await call('POST', '/v1/workspaces', alice.cookie, { name: 'x'.repeat(81) })).statusCode,
    ).toBe(400)
  })

  it('is protected by the CSRF guard like every unsafe route', async () => {
    const alice = await register(app, 'alice@example.com')

    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie: alice.cookie, origin: 'https://evil.example' },
      payload: { name: 'Phishing' },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('members and roles', () => {
  async function workspaceWithAdmin() {
    const owner = await register(app, 'owner@example.com', 'Owner')
    const admin = await register(app, 'admin@example.com', 'Admin')
    const member = await register(app, 'member@example.com', 'Member')
    const workspace = await createWorkspace(owner.cookie, 'Acme')
    await addMember(owner.cookie, workspace.id, 'admin@example.com', 'admin')
    await addMember(owner.cookie, workspace.id, 'member@example.com', 'member')
    return { owner, admin, member, workspace, base: `/v1/workspaces/${workspace.id}/members` }
  }

  it('lists members with their profile and role, never credentials', async () => {
    const { member, base } = await workspaceWithAdmin()

    const response = await call('GET', base, member.cookie)

    const { items } = memberListSchema.parse(response.json())
    expect(items.map((m) => [m.email, m.role])).toEqual([
      ['owner@example.com', 'owner'],
      ['admin@example.com', 'admin'],
      ['member@example.com', 'member'],
    ])
    expect(response.body).not.toMatch(/password|hash|token/i)
  })

  it('lets admins add members but only owners grant the owner role', async () => {
    const { admin, owner, workspace } = await workspaceWithAdmin()
    await register(app, 'new@example.com')

    expect(
      (await addMember(admin.cookie, workspace.id, 'new@example.com', 'owner')).statusCode,
    ).toBe(403)
    expect(
      (await addMember(admin.cookie, workspace.id, 'new@example.com', 'editor')).statusCode,
    ).toBe(201)
    expect(
      (await addMember(owner.cookie, workspace.id, 'new@example.com', 'editor')).statusCode,
    ).toBe(409)
    expect(
      (await addMember(owner.cookie, workspace.id, 'ghost@example.com', 'editor')).statusCode,
    ).toBe(404)
  })

  it('stops admins from changing or removing an owner', async () => {
    const { admin, owner, base } = await workspaceWithAdmin()

    expect(
      (await call('PATCH', `${base}/${owner.userId}`, admin.cookie, { role: 'member' })).statusCode,
    ).toBe(403)
    expect((await call('DELETE', `${base}/${owner.userId}`, admin.cookie)).statusCode).toBe(403)
  })

  it('never leaves a workspace without an owner', async () => {
    const { owner, base } = await workspaceWithAdmin()

    const demote = await call('PATCH', `${base}/${owner.userId}`, owner.cookie, { role: 'admin' })
    const leave = await call('DELETE', `${base}/${owner.userId}`, owner.cookie)

    expect(demote.statusCode).toBe(409)
    expect(leave.statusCode).toBe(409)
    expect(apiErrorSchema.parse(leave.json()).error.message).toMatch(/at least one owner/)
  })

  it('transfers ownership: promote another owner, then step down', async () => {
    const { owner, admin, base } = await workspaceWithAdmin()

    expect(
      (await call('PATCH', `${base}/${admin.userId}`, owner.cookie, { role: 'owner' })).statusCode,
    ).toBe(200)
    expect(
      (await call('PATCH', `${base}/${owner.userId}`, owner.cookie, { role: 'member' })).statusCode,
    ).toBe(200)
  })

  it('lets any member leave, after which the workspace is invisible to them', async () => {
    const { member, workspace, base } = await workspaceWithAdmin()

    expect((await call('DELETE', `${base}/${member.userId}`, member.cookie)).statusCode).toBe(204)
    expect((await call('GET', `/v1/workspaces/${workspace.id}`, member.cookie)).statusCode).toBe(
      404,
    )
  })
})
