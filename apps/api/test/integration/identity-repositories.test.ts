import { createHash, randomBytes } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  findSessionByTokenHash,
  insertSession,
  revokeSession,
} from '../../src/modules/auth/sessions.repository.js'
import { findUserByEmail, insertUser } from '../../src/modules/auth/users.repository.js'
import {
  countOwners,
  deleteMember,
  findMembership,
  insertMember,
  insertWorkspaceWithOwner,
  listMembers,
  listWorkspacesForUser,
} from '../../src/modules/workspaces/workspaces.repository.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
const { db } = database

afterAll(() => database.close())
beforeEach(() => resetTestDatabase(database))

async function createUser(email: string) {
  const result = await insertUser(db, { email, displayName: email, passwordHash: '$argon2id$stub' })
  if (!result.ok) throw new Error('user not created')
  return result.user
}

const tokenHash = () => createHash('sha256').update(randomBytes(32)).digest()

describe('users', () => {
  it('finds users by email case-insensitively and keeps the stored casing', async () => {
    await createUser('Alice@Example.com')

    const user = await findUserByEmail(db, 'alice@example.COM')

    expect(user?.email).toBe('Alice@Example.com')
  })

  it('rejects a second account whose email differs only in case', async () => {
    await createUser('bob@example.com')

    const result = await insertUser(db, {
      email: 'BOB@example.com',
      displayName: 'Bob',
      passwordHash: '$argon2id$stub',
    })

    expect(result).toEqual({ ok: false, reason: 'email-taken' })
  })

  it('generates UUIDv7 primary keys in the database', async () => {
    const user = await createUser('carol@example.com')

    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('sessions', () => {
  it('stores a 32-byte hash and finds the session with its user', async () => {
    const user = await createUser('dave@example.com')
    const hash = tokenHash()
    await insertSession(db, {
      userId: user.id,
      tokenHash: hash,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: 'vitest',
      ip: '127.0.0.1',
    })

    const found = await findSessionByTokenHash(db, hash)

    expect(found?.user.id).toBe(user.id)
    expect(Buffer.compare(found?.session.tokenHash ?? Buffer.alloc(0), hash)).toBe(0)
  })

  it('rejects anything that is not a 32-byte digest', async () => {
    const user = await createUser('erin@example.com')

    await expect(
      insertSession(db, {
        userId: user.id,
        tokenHash: Buffer.from('raw-token-would-be-a-bug'),
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ip: null,
      }),
    ).rejects.toThrow()
  })

  it('no longer finds a revoked session', async () => {
    const user = await createUser('frank@example.com')
    const hash = tokenHash()
    const session = await insertSession(db, {
      userId: user.id,
      tokenHash: hash,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: null,
      ip: null,
    })

    await revokeSession(db, session.id, new Date())

    expect(await findSessionByTokenHash(db, hash)).toBeUndefined()
  })

  it("deletes a user's sessions together with the user", async () => {
    const user = await createUser('grace@example.com')
    const hash = tokenHash()
    await insertSession(db, {
      userId: user.id,
      tokenHash: hash,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: null,
      ip: null,
    })

    await db.execute(sql`delete from users where id = ${user.id}`)

    expect(await findSessionByTokenHash(db, hash)).toBeUndefined()
  })
})

describe('workspaces and memberships', () => {
  it('creates a workspace with its creator as owner', async () => {
    const owner = await createUser('owner@example.com')

    const { workspace, role } = await insertWorkspaceWithOwner(db, {
      name: 'Acme',
      ownerId: owner.id,
    })

    expect(role).toBe('owner')
    expect(await listWorkspacesForUser(db, owner.id)).toEqual([{ workspace, role: 'owner' }])
    expect(await countOwners(db, workspace.id)).toBe(1)
  })

  it('finds a membership only for members of that workspace', async () => {
    const owner = await createUser('owner@example.com')
    const outsider = await createUser('outsider@example.com')
    const { workspace } = await insertWorkspaceWithOwner(db, { name: 'Acme', ownerId: owner.id })

    expect((await findMembership(db, workspace.id, owner.id))?.role).toBe('owner')
    expect(await findMembership(db, workspace.id, outsider.id)).toBeUndefined()
  })

  it('adds, lists and removes members, and rejects duplicates', async () => {
    const owner = await createUser('owner@example.com')
    const editor = await createUser('editor@example.com')
    const { workspace } = await insertWorkspaceWithOwner(db, { name: 'Acme', ownerId: owner.id })

    expect(
      await insertMember(db, { workspaceId: workspace.id, userId: editor.id, role: 'editor' }),
    ).toEqual({ ok: true })
    expect(
      await insertMember(db, { workspaceId: workspace.id, userId: editor.id, role: 'member' }),
    ).toEqual({ ok: false, reason: 'already-member' })
    expect((await listMembers(db, workspace.id)).map((m) => [m.userId, m.role])).toEqual([
      [owner.id, 'owner'],
      [editor.id, 'editor'],
    ])

    await deleteMember(db, workspace.id, editor.id)

    expect(await findMembership(db, workspace.id, editor.id)).toBeUndefined()
  })

  it('enforces the role list in the database', async () => {
    const owner = await createUser('owner@example.com')
    const { workspace } = await insertWorkspaceWithOwner(db, { name: 'Acme', ownerId: owner.id })

    await expect(
      db.execute(
        sql`update workspace_members set role = 'superuser' where workspace_id = ${workspace.id}`,
      ),
    ).rejects.toThrow()
  })
})
