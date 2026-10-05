import { fileURLToPath } from 'node:url'

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

import { createDatabase, type Database } from '../../../src/infrastructure/database/client.js'

/**
 * Integration tests run against a dedicated database on the local PostgreSQL
 * (compose.yaml) or the CI service container, never the development database.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://contextlayer:contextlayer@localhost:5432/contextlayer_test'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url))

/** Destructive tests only run against a database whose name ends with `_test`. */
export function testDatabaseName(url: string = TEST_DATABASE_URL): string {
  const name = decodeURIComponent(new URL(url).pathname.slice(1))
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${name}": TEST_DATABASE_URL must name a database ending in _test.`,
    )
  }
  return name
}

/** Creates the test database if needed and applies every migration (Vitest globalSetup). */
export async function prepareTestDatabase(): Promise<void> {
  const name = testDatabaseName()
  const adminUrl = new URL(TEST_DATABASE_URL)
  adminUrl.pathname = '/postgres'

  const admin = new pg.Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [name])
    if (existing.rowCount === 0) {
      // Identifiers cannot be bound as parameters; the name was validated above.
      await admin.query(`create database "${name.replaceAll('"', '""')}"`)
    }
  } finally {
    await admin.end()
  }

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await pool.end()
  }
}

export function connectTestDatabase(): Database {
  testDatabaseName()
  return createDatabase({ url: TEST_DATABASE_URL, logger: { error: () => undefined } })
}

/** Empties every table between tests (files run sequentially, see the Vitest config). */
export async function resetTestDatabase(database: Database): Promise<void> {
  await database.db.execute(
    sql`truncate table guide_versions, guide_steps, guides, applications, workspace_members, sessions, workspaces, users cascade`,
  )
}
