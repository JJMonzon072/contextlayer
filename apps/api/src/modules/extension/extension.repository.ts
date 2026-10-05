import type { GrantRevocationReason } from '@contextlayer/shared'
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm'

import type { DbExecutor } from '../../infrastructure/database/client.js'
import {
  extensionAccessTokens,
  extensionAuthCodes,
  extensionGrants,
  extensionRefreshTokens,
} from './extension.schema.js'

/** Credentials are looked up by hash only; their values never reach these queries. */

export interface GrantRow {
  id: string
  userId: string
  workspaceId: string
  clientId: string
  label: string
  createdAt: Date
  expiresAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
  revokedReason: GrantRevocationReason | null
}

const grantColumns = {
  id: extensionGrants.id,
  userId: extensionGrants.userId,
  workspaceId: extensionGrants.workspaceId,
  clientId: extensionGrants.clientId,
  label: extensionGrants.label,
  createdAt: extensionGrants.createdAt,
  expiresAt: extensionGrants.expiresAt,
  lastUsedAt: extensionGrants.lastUsedAt,
  revokedAt: extensionGrants.revokedAt,
  revokedReason: extensionGrants.revokedReason,
}

export async function insertCode(
  db: DbExecutor,
  values: {
    codeHash: Buffer
    userId: string
    workspaceId: string
    clientId: string
    codeChallenge: string
    label: string
    createdAt: Date
    expiresAt: Date
  },
): Promise<void> {
  await db.insert(extensionAuthCodes).values({ ...values, codeChallengeMethod: 'S256' })
}

/**
 * Marks the code consumed and returns it, in one statement: of two concurrent
 * exchanges, only one gets the row (the other waits for the row lock and then
 * finds `consumed_at` set).
 */
export async function consumeCode(db: DbExecutor, codeHash: Buffer, now: Date) {
  const [row] = await db
    .update(extensionAuthCodes)
    .set({ consumedAt: now })
    .where(and(eq(extensionAuthCodes.codeHash, codeHash), isNull(extensionAuthCodes.consumedAt)))
    .returning({
      id: extensionAuthCodes.id,
      userId: extensionAuthCodes.userId,
      workspaceId: extensionAuthCodes.workspaceId,
      clientId: extensionAuthCodes.clientId,
      codeChallenge: extensionAuthCodes.codeChallenge,
      label: extensionAuthCodes.label,
      expiresAt: extensionAuthCodes.expiresAt,
    })
  return row
}

/** A code already consumed: the grant it created, if any (replay detection). */
export async function findConsumedCodeGrant(
  db: DbExecutor,
  codeHash: Buffer,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ grantId: extensionAuthCodes.grantId })
    .from(extensionAuthCodes)
    .where(eq(extensionAuthCodes.codeHash, codeHash))
  return row?.grantId
}

export async function attachGrantToCode(
  db: DbExecutor,
  codeId: string,
  grantId: string,
): Promise<void> {
  await db.update(extensionAuthCodes).set({ grantId }).where(eq(extensionAuthCodes.id, codeId))
}

export async function insertGrant(
  db: DbExecutor,
  values: {
    userId: string
    workspaceId: string
    clientId: string
    label: string
    createdAt: Date
    expiresAt: Date
  },
): Promise<GrantRow> {
  const [row] = await db.insert(extensionGrants).values(values).returning(grantColumns)
  if (!row) throw new Error('insert into extension_grants returned no row')
  return row
}

export async function findGrant(db: DbExecutor, grantId: string): Promise<GrantRow | undefined> {
  const [row] = await db
    .select(grantColumns)
    .from(extensionGrants)
    .where(eq(extensionGrants.id, grantId))
  return row
}

/** Serializes refresh and revocation of one grant for the rest of the transaction. */
export async function lockGrant(db: DbExecutor, grantId: string): Promise<GrantRow | undefined> {
  const [row] = await db
    .select(grantColumns)
    .from(extensionGrants)
    .where(eq(extensionGrants.id, grantId))
    .for('update')
  return row
}

/** Idempotent: an already revoked grant keeps its first reason. */
export async function revokeGrant(
  db: DbExecutor,
  grantId: string,
  reason: GrantRevocationReason,
  now: Date,
): Promise<void> {
  await db
    .update(extensionGrants)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(extensionGrants.id, grantId), isNull(extensionGrants.revokedAt)))
}

export async function insertAccessToken(
  db: DbExecutor,
  values: { grantId: string; tokenHash: Buffer; createdAt: Date; expiresAt: Date },
): Promise<void> {
  await db.insert(extensionAccessTokens).values(values)
}

export async function insertRefreshToken(
  db: DbExecutor,
  values: {
    grantId: string
    tokenHash: Buffer
    parentId: string | null
    createdAt: Date
    expiresAt: Date
  },
): Promise<void> {
  await db.insert(extensionRefreshTokens).values(values)
}

/** The grant behind a live access token: token and grant unexpired, grant not revoked. */
export async function findGrantByAccessToken(
  db: DbExecutor,
  tokenHash: Buffer,
  now: Date,
): Promise<GrantRow | undefined> {
  const [row] = await db
    .select(grantColumns)
    .from(extensionAccessTokens)
    .innerJoin(extensionGrants, eq(extensionGrants.id, extensionAccessTokens.grantId))
    .where(
      and(
        eq(extensionAccessTokens.tokenHash, tokenHash),
        gt(extensionAccessTokens.expiresAt, now),
        isNull(extensionGrants.revokedAt),
        gt(extensionGrants.expiresAt, now),
      ),
    )
  return row
}

/** Records activity at most once a minute per grant. */
export async function touchGrant(db: DbExecutor, grantId: string, now: Date): Promise<void> {
  await db
    .update(extensionGrants)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(extensionGrants.id, grantId),
        or(
          isNull(extensionGrants.lastUsedAt),
          lt(extensionGrants.lastUsedAt, new Date(now.getTime() - 60_000)),
        ),
      ),
    )
}

export function listGrantsForUser(
  db: DbExecutor,
  userId: string,
  limit: number,
): Promise<GrantRow[]> {
  return db
    .select(grantColumns)
    .from(extensionGrants)
    .where(eq(extensionGrants.userId, userId))
    .orderBy(desc(extensionGrants.id))
    .limit(limit)
}

/** Scoped by owner: another user's grant id behaves like an unknown id. */
export async function findGrantOfUser(
  db: DbExecutor,
  userId: string,
  grantId: string,
): Promise<GrantRow | undefined> {
  const [row] = await db
    .select(grantColumns)
    .from(extensionGrants)
    .where(and(eq(extensionGrants.id, grantId), eq(extensionGrants.userId, userId)))
  return row
}
