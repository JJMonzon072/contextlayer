import { and, eq, isNull } from 'drizzle-orm'

import type { DbExecutor } from '../../infrastructure/database/client.js'
import { sessions, users } from './auth.schema.js'

export type SessionRecord = typeof sessions.$inferSelect

export async function insertSession(
  db: DbExecutor,
  input: {
    userId: string
    tokenHash: Buffer
    expiresAt: Date
    userAgent: string | null
    ip: string | null
  },
): Promise<SessionRecord> {
  const [session] = await db.insert(sessions).values(input).returning()
  if (!session) throw new Error('insert into sessions returned no row')
  return session
}

/**
 * Looks a session up by the SHA-256 of its token. Expiry rules live in the
 * service (with an injectable clock); only revoked sessions are excluded here.
 */
export async function findSessionByTokenHash(db: DbExecutor, tokenHash: Buffer) {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
  return row
}

export async function touchSession(db: DbExecutor, sessionId: string, now: Date): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId))
}

export async function revokeSession(db: DbExecutor, sessionId: string, now: Date): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
}
