import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

import { workspaces } from '../workspaces/workspaces.schema.js'

/**
 * A web application a workspace builds guides for. `origins` holds exact,
 * normalized origins (packages/shared/src/origins.ts); the CHECK repeats the
 * essentials so no path, query, fragment, credential or wildcard can be stored
 * even by code that bypasses the API.
 */
export const applications = pgTable(
  'applications',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    origins: text().array().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Target of the composite FK from guides, and the index of the per-workspace list.
    unique('applications_workspace_id_id_key').on(table.workspaceId, table.id),
    // Origin lookups for the extension: `origins @> array[$origin]`.
    index('applications_origins_gin').using('gin', table.origins),
    check(
      'applications_origins_check',
      sql`cardinality(${table.origins}) between 1 and 20
        and array_position(${table.origins}, null) is null
        and array_to_string(${table.origins}, ',') ~ '^https?://[^/?#@,*[:space:]]+(,https?://[^/?#@,*[:space:]]+)*$'
        and array_to_string(${table.origins}, ',') = lower(array_to_string(${table.origins}, ','))`,
    ),
  ],
)
