import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  extensionAccessTokens,
  extensionAuthCodes,
  extensionGrants,
  extensionRefreshTokens,
  users,
  workspaceMembers,
  workspaces,
} from '../../src/infrastructure/database/schema.js'
import { generateCredential, hashCredential } from '../../src/modules/extension/credentials.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

/** Invariants PostgreSQL enforces for extension connections, without the API. */
const database = connectTestDatabase()
const { db } = database

afterAll(() => database.close())
beforeEach(() => resetTestDatabase(database))

const CLIENT = 'ebdclkadgcmjipockfofmlakcfijojko'
const NOW = new Date('2026-10-05T12:00:00Z')
const LATER = new Date('2026-11-04T12:00:00Z')

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    return typeof cause === 'object' && cause !== null && 'code' in cause
      ? String(cause.code)
      : 'unknown'
  }
}

async function member() {
  const [user] = await db
    .insert(users)
    .values({ email: 'alice@example.test', passwordHash: 'x', displayName: 'Alice' })
    .returning()
  const [workspace] = await db.insert(workspaces).values({ name: 'Acme' }).returning()
  if (!user || !workspace) throw new Error('setup failed')
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace.id, userId: user.id, role: 'member' })
  return { userId: user.id, workspaceId: workspace.id }
}

async function grantFor(owner: { userId: string; workspaceId: string }) {
  const [grant] = await db
    .insert(extensionGrants)
    .values({ ...owner, clientId: CLIENT, label: 'Chrome', createdAt: NOW, expiresAt: LATER })
    .returning()
  if (!grant) throw new Error('no grant')
  return grant
}

describe('extension grants', () => {
  it('need an existing membership (no grant for a workspace the user is not in)', async () => {
    const owner = await member()
    const [other] = await db.insert(workspaces).values({ name: 'Globex' }).returning()
    if (!other) throw new Error('no workspace')

    expect(await sqlState(grantFor({ userId: owner.userId, workspaceId: other.id }))).toBe('23503')
  })

  it('disappear with the membership, tokens included, so re-adding the member revives nothing', async () => {
    const owner = await member()
    const grant = await grantFor(owner)
    await db.insert(extensionAccessTokens).values({
      grantId: grant.id,
      tokenHash: hashCredential(generateCredential('access')),
      createdAt: NOW,
      expiresAt: LATER,
    })

    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, owner.userId))
    await db.insert(workspaceMembers).values({ ...owner, role: 'member' })

    expect(await db.select().from(extensionGrants)).toEqual([])
    expect(await db.select().from(extensionAccessTokens)).toEqual([])
  })

  it('keep the revocation time and reason together, from a known list', async () => {
    const grant = await grantFor(await member())

    expect(
      await sqlState(
        db.update(extensionGrants).set({ revokedAt: NOW }).where(eq(extensionGrants.id, grant.id)),
      ),
    ).toBe('23514')
    expect(
      await sqlState(
        db
          .update(extensionGrants)
          .set({ revokedAt: NOW, revokedReason: 'whatever' as 'dashboard' })
          .where(eq(extensionGrants.id, grant.id)),
      ),
    ).toBe('23514')
  })

  it('refuse a malformed client id or an expiry before creation', async () => {
    const owner = await member()
    expect(
      await sqlState(
        db.insert(extensionGrants).values({
          ...owner,
          clientId: 'not-an-id',
          label: 'x',
          createdAt: NOW,
          expiresAt: LATER,
        }),
      ),
    ).toBe('23514')
    expect(
      await sqlState(
        db
          .insert(extensionGrants)
          .values({ ...owner, clientId: CLIENT, label: 'x', createdAt: LATER, expiresAt: NOW }),
      ),
    ).toBe('23514')
  })
})

describe('extension credentials storage', () => {
  it('stores hashes only: exactly 32 bytes, each unique', async () => {
    const grant = await grantFor(await member())
    const hash = hashCredential(generateCredential('refresh'))
    const row = { grantId: grant.id, tokenHash: hash, createdAt: NOW, expiresAt: LATER }

    await db.insert(extensionRefreshTokens).values(row)
    expect(await sqlState(db.insert(extensionRefreshTokens).values(row))).toBe('23505')
    expect(
      await sqlState(
        db.insert(extensionRefreshTokens).values({ ...row, tokenHash: Buffer.from('short') }),
      ),
    ).toBe('23514')
  })

  it('accepts S256 codes only, with a well-formed challenge', async () => {
    const owner = await member()
    const code = {
      ...owner,
      codeHash: hashCredential(generateCredential('code')),
      clientId: CLIENT,
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      label: 'Chrome',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    }

    expect(
      await sqlState(
        db.insert(extensionAuthCodes).values({ ...code, codeChallengeMethod: 'plain' }),
      ),
    ).toBe('23514')
    expect(
      await sqlState(db.insert(extensionAuthCodes).values({ ...code, codeChallenge: 'short' })),
    ).toBe('23514')
    await db.insert(extensionAuthCodes).values(code)
  })
})
