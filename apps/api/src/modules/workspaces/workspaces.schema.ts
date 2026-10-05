import { WORKSPACE_ROLES } from '@contextlayer/shared'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { users } from '../auth/auth.schema.js'

export const workspaces = pgTable('workspaces', {
  id: uuid()
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

const roleList = sql.raw(WORKSPACE_ROLES.map((role) => `'${role}'`).join(', '))

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: WORKSPACE_ROLES }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    check('workspace_members_role_check', sql`${table.role} in (${roleList})`),
    // The primary key serves lookups by workspace; this one serves "my workspaces".
    index('workspace_members_user_idx').on(table.userId),
  ],
)
