import {
  GUIDE_STATUSES,
  STEP_PLACEMENTS,
  type GuideSnapshot,
  type RichText,
  type TargetDescriptor,
  type UrlPattern,
} from '@contextlayer/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { applications } from '../applications/applications.schema.js'
import { users } from '../auth/auth.schema.js'
import { workspaces } from '../workspaces/workspaces.schema.js'

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))

/**
 * The editable draft of a guide. Published content lives in `guide_versions`
 * (ADR 0016); `revision` increases on every draft change, so a version records
 * which revision it froze and the API can tell whether the draft moved on.
 */
export const guides = pgTable(
  'guides',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    applicationId: uuid().notNull(),
    title: text().notNull(),
    description: text().notNull().default(''),
    status: text({ enum: GUIDE_STATUSES }).notNull().default('draft'),
    /** URLPattern init; null = any page of the application. */
    startUrlPattern: jsonb().$type<UrlPattern>(),
    revision: integer().notNull().default(1),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    // The application must belong to the same workspace (no cross-tenant parent).
    foreignKey({
      name: 'guides_application_fk',
      columns: [table.workspaceId, table.applicationId],
      foreignColumns: [applications.workspaceId, applications.id],
    }).onDelete('restrict'),
    check('guides_status_check', sql`${table.status} in (${list(GUIDE_STATUSES)})`),
    check(
      'guides_archived_check',
      sql`(${table.status} = 'archived') = (${table.archivedAt} is not null)`,
    ),
    check('guides_revision_check', sql`${table.revision} >= 1`),
    check(
      'guides_start_url_pattern_check',
      sql`${table.startUrlPattern} is null or jsonb_typeof(${table.startUrlPattern}) = 'object'`,
    ),
    // Keyset pagination is newest first by UUIDv7 id.
    index('guides_workspace_list_idx').on(table.workspaceId, table.id.desc()),
    // Per-application lists; also serves the composite FK when an application is deleted.
    index('guides_application_list_idx').on(
      table.workspaceId,
      table.applicationId,
      table.id.desc(),
    ),
  ],
)

/**
 * Draft steps, 0-based and contiguous. `unique (guide_id, position)` is
 * DEFERRABLE INITIALLY DEFERRED, which drizzle-kit cannot express: it lives in
 * the custom migration `0002_content_constraints.sql` (docs/data-model.md 3.10).
 */
export const guideSteps = pgTable(
  'guide_steps',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    guideId: uuid()
      .notNull()
      .references(() => guides.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    title: text().notNull(),
    body: jsonb().$type<RichText>().notNull(),
    /** Null until Edit Mode captures the element (Phase 5), or for an unanchored step. */
    target: jsonb().$type<TargetDescriptor>(),
    urlPattern: jsonb().$type<UrlPattern>(),
    placement: text({ enum: STEP_PLACEMENTS }).notNull().default('auto'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('guide_steps_position_check', sql`${table.position} >= 0`),
    check('guide_steps_placement_check', sql`${table.placement} in (${list(STEP_PLACEMENTS)})`),
    check(
      'guide_steps_body_check',
      sql`jsonb_typeof(${table.body}) = 'object' and ${table.body} ? 'version'`,
    ),
    check(
      'guide_steps_target_check',
      sql`${table.target} is null or (jsonb_typeof(${table.target}) = 'object' and ${table.target} ? 'version')`,
    ),
    check(
      'guide_steps_url_pattern_check',
      sql`${table.urlPattern} is null or jsonb_typeof(${table.urlPattern}) = 'object'`,
    ),
  ],
)

/**
 * Immutable published snapshots (ADR 0016). Triggers in the custom migrations
 * reject every DELETE (0003) and every UPDATE except clearing `published_by`
 * (0002); RESTRICT keeps a guide from being deleted while it has versions.
 */
export const guideVersions = pgTable(
  'guide_versions',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    guideId: uuid()
      .notNull()
      .references(() => guides.id, { onDelete: 'restrict' }),
    version: integer().notNull(),
    /** The `guides.revision` this version froze. */
    guideRevision: integer().notNull(),
    snapshot: jsonb().$type<GuideSnapshot>().notNull(),
    publishedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('guide_versions_guide_id_version_key').on(table.guideId, table.version),
    check('guide_versions_version_check', sql`${table.version} >= 1`),
    check('guide_versions_guide_revision_check', sql`${table.guideRevision} >= 1`),
    check(
      'guide_versions_snapshot_check',
      sql`jsonb_typeof(${table.snapshot}) = 'object' and ${table.snapshot} ? 'version'`,
    ),
  ],
)
