import { sql } from 'drizzle-orm'
import {
  check,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { bytea } from '../../infrastructure/database/columns.js'

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

export const users = pgTable(
  'users',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    // Stored as entered (trimmed); uniqueness and lookups use lower(email).
    email: text().notNull(),
    // argon2id PHC string; the password itself is never stored.
    passwordHash: text().notNull(),
    displayName: text().notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_lower_key').on(sql`lower(${table.email})`)],
)

/** Dashboard sessions (ADR 0015). The raw token only exists in the client's cookie. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea().notNull().unique('sessions_token_hash_key'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Idle expiry is measured from here; refreshed at most once a minute.
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Absolute expiry, fixed at creation.
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    userAgent: text(),
    ip: inet(),
  },
  (table) => [
    check('sessions_token_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
    // Full index: also serves the ON DELETE CASCADE from users.
    index('sessions_user_idx').on(table.userId),
  ],
)
