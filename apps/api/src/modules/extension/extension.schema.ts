import { GRANT_REVOCATION_REASONS } from '@contextlayer/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

import { bytea } from '../../infrastructure/database/columns.js'
import { workspaceMembers } from '../workspaces/workspaces.schema.js'

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))
const timestamptz = () => timestamp({ withTimezone: true })

/**
 * Extension connections (ADR 0015). Each credential type has its own table, so
 * a code can never be presented as a token or a refresh token as an access
 * token. Only SHA-256 hashes are stored; the values exist only in transit and
 * in the extension's protected storage.
 *
 * Grants, codes and their tokens reference the membership (workspace, user):
 * removing a member deletes them, so re-adding the member never revives an
 * old connection.
 */
export const extensionGrants = pgTable(
  'extension_grants',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid().notNull(),
    workspaceId: uuid().notNull(),
    /** The extension id the connection was issued to. */
    clientId: text().notNull(),
    label: text().notNull(),
    createdAt: timestamptz().notNull(),
    /** Hard limit: refreshes never extend it. */
    expiresAt: timestamptz().notNull(),
    lastUsedAt: timestamptz(),
    revokedAt: timestamptz(),
    revokedReason: text({ enum: GRANT_REVOCATION_REASONS }),
  },
  (table) => [
    foreignKey({
      name: 'extension_grants_member_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
    }).onDelete('cascade'),
    check('extension_grants_client_id_check', sql`${table.clientId} ~ '^[a-p]{32}$'`),
    check('extension_grants_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'extension_grants_revocation_check',
      sql`(${table.revokedAt} is null) = (${table.revokedReason} is null)`,
    ),
    check(
      'extension_grants_revoked_reason_check',
      sql`${table.revokedReason} is null or ${table.revokedReason} in (${list(GRANT_REVOCATION_REASONS)})`,
    ),
    // "My connections", newest first; the member index serves the cascade.
    index('extension_grants_user_idx').on(table.userId, table.id.desc()),
    index('extension_grants_member_idx').on(table.workspaceId, table.userId),
  ],
)

/** One-time codes (60 s) handed from the dashboard to the extension. */
export const extensionAuthCodes = pgTable(
  'extension_auth_codes',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    codeHash: bytea().notNull(),
    userId: uuid().notNull(),
    workspaceId: uuid().notNull(),
    clientId: text().notNull(),
    codeChallenge: text().notNull(),
    codeChallengeMethod: text().notNull(),
    label: text().notNull(),
    createdAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
    consumedAt: timestamptz(),
    /** Set when consumed: a replayed code revokes the grant it created. */
    grantId: uuid().references(() => extensionGrants.id, { onDelete: 'set null' }),
  },
  (table) => [
    unique('extension_auth_codes_code_hash_key').on(table.codeHash),
    foreignKey({
      name: 'extension_auth_codes_member_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
    }).onDelete('cascade'),
    check('extension_auth_codes_code_hash_length', sql`octet_length(${table.codeHash}) = 32`),
    check('extension_auth_codes_client_id_check', sql`${table.clientId} ~ '^[a-p]{32}$'`),
    check(
      'extension_auth_codes_challenge_check',
      sql`${table.codeChallenge} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check('extension_auth_codes_method_check', sql`${table.codeChallengeMethod} = 'S256'`),
    check('extension_auth_codes_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    index('extension_auth_codes_member_idx').on(table.workspaceId, table.userId),
    index('extension_auth_codes_grant_idx').on(table.grantId),
  ],
)

export const extensionRefreshTokens = pgTable(
  'extension_refresh_tokens',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    grantId: uuid()
      .notNull()
      .references(() => extensionGrants.id, { onDelete: 'cascade' }),
    tokenHash: bytea().notNull(),
    /** The token this one replaced: the rotation chain. */
    parentId: uuid().references((): AnyPgColumn => extensionRefreshTokens.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
    /** Set when exchanged; presenting it again is reuse and revokes the grant. */
    usedAt: timestamptz(),
  },
  (table) => [
    unique('extension_refresh_tokens_token_hash_key').on(table.tokenHash),
    check('extension_refresh_tokens_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
    index('extension_refresh_tokens_grant_idx').on(table.grantId),
    index('extension_refresh_tokens_parent_idx').on(table.parentId),
  ],
)

export const extensionAccessTokens = pgTable(
  'extension_access_tokens',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    grantId: uuid()
      .notNull()
      .references(() => extensionGrants.id, { onDelete: 'cascade' }),
    tokenHash: bytea().notNull(),
    createdAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
  },
  (table) => [
    unique('extension_access_tokens_token_hash_key').on(table.tokenHash),
    check('extension_access_tokens_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
    index('extension_access_tokens_grant_idx').on(table.grantId),
  ],
)
