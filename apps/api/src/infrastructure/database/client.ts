import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from './schema.js'

export type DrizzleDatabase = NodePgDatabase<typeof schema>

export interface Database {
  /** Query builder for repositories. */
  readonly db: DrizzleDatabase
  /** Cheap round-trip used by the health check. Rejects when PostgreSQL is unreachable. */
  ping(): Promise<void>
  /** Drains the connection pool. Called once on graceful shutdown. */
  close(): Promise<void>
}

interface DatabaseLogger {
  error(payload: object, message: string): void
}

export function createDatabase(options: { url: string; logger: DatabaseLogger }): Database {
  const pool = new pg.Pool({
    connectionString: options.url,
    application_name: 'contextlayer-api',
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })

  // An idle client can fail (e.g. PostgreSQL restarts). Without a listener the
  // pool re-emits the error and crashes the process; log it and let the pool
  // replace the client instead.
  pool.on('error', (error) => {
    options.logger.error({ err: error }, 'idle PostgreSQL client error')
  })

  const db = drizzle({ client: pool, schema, casing: 'snake_case' })

  return {
    db,
    async ping() {
      await db.execute(sql`select 1`)
    },
    async close() {
      await pool.end()
    },
  }
}
