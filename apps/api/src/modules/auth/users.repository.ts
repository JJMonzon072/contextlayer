import { eq, sql } from 'drizzle-orm'

import { isUniqueViolation, type DbExecutor } from '../../infrastructure/database/client.js'
import { users } from './auth.schema.js'

export type UserRecord = typeof users.$inferSelect

export type InsertUserResult = { ok: true; user: UserRecord } | { ok: false; reason: 'email-taken' }

export async function insertUser(
  db: DbExecutor,
  input: { email: string; displayName: string; passwordHash: string },
): Promise<InsertUserResult> {
  try {
    const [user] = await db.insert(users).values(input).returning()
    if (!user) throw new Error('insert into users returned no row')
    return { ok: true, user }
  } catch (error) {
    if (isUniqueViolation(error, 'users_email_lower_key'))
      return { ok: false, reason: 'email-taken' }
    throw error
  }
}

/** The only email lookup: case-insensitive, matching the `lower(email)` unique index. */
export async function findUserByEmail(
  db: DbExecutor,
  email: string,
): Promise<UserRecord | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
  return user
}

export async function findUserById(db: DbExecutor, id: string): Promise<UserRecord | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id))
  return user
}
