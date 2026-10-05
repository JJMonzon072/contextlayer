/**
 * Starts the BUILT API for the Playwright suites on a dedicated, disposable
 * database, never the development one:
 *
 *   1. E2E_DATABASE_URL (default …/contextlayer_e2e) must name a database
 *      ending in `_e2e`; anything else is refused before connecting.
 *   2. The database is created if needed, migrated, and every table in the
 *      `public` schema is truncated, so each run starts empty.
 *   3. dist/server.js is started in this process with an explicit
 *      environment: the repository's .env is not read. Per-IP rate limits
 *      are raised, since every test signs up from the same address.
 *
 * Run `pnpm build` first (the root `pnpm test:e2e` does).
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://contextlayer:contextlayer@localhost:5432/contextlayer_e2e'
const PORT = process.env.E2E_API_PORT ?? '3100'
const DASHBOARD_ORIGIN = process.env.E2E_DASHBOARD_ORIGIN ?? 'http://localhost:4173'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))
const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url))

function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.slice(1))
  if (!/^[a-z0-9_]+_e2e$/.test(name)) {
    throw new Error(
      `Refusing to prepare "${name}" for end-to-end tests: E2E_DATABASE_URL must name a database ending in _e2e.`,
    )
  }
  return name
}

async function prepare(): Promise<void> {
  const name = databaseName(E2E_DATABASE_URL)
  const adminUrl = new URL(E2E_DATABASE_URL)
  adminUrl.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [name])
    // The name was validated above (letters, digits, underscores).
    if (existing.rowCount === 0) await admin.query(`create database "${name}"`)
  } finally {
    await admin.end()
  }

  const pool = new pg.Pool({ connectionString: E2E_DATABASE_URL, max: 1 })
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER })
    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    )
    if (rows.length > 0) {
      const tables = rows.map((row) => `"public"."${row.tablename.replaceAll('"', '""')}"`)
      await pool.query(`truncate table ${tables.join(', ')} cascade`)
    }
  } finally {
    await pool.end()
  }
}

if (!existsSync(SERVER)) {
  throw new Error(`${SERVER} is missing: run \`pnpm build\` first.`)
}
await prepare()

Object.assign(process.env, {
  API_HOST: 'localhost',
  API_PORT: PORT,
  DATABASE_URL: E2E_DATABASE_URL,
  DASHBOARD_ORIGIN,
  LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
  // Every test signs up and connects from 127.0.0.1, so the per-IP limits are
  // raised here; the limits themselves are covered by the integration tests.
  REGISTER_RATE_LIMIT_MAX: '10000',
  LOGIN_RATE_LIMIT_MAX: '10000',
  EXTENSION_CODE_RATE_LIMIT_MAX: '10000',
  EXTENSION_TOKEN_RATE_LIMIT_MAX: '10000',
})
await import(SERVER)
