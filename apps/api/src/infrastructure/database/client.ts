import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from './schema.js'

export type DrizzleDatabase = NodePgDatabase<typeof schema>

export interface Database {
  /** Query builder for repositories. */
  readonly db: DrizzleDatabase
  /**
   * Cheap round-trip used by the health check. Rejects when PostgreSQL is
   * unreachable or does not answer within `timeoutMs`.
   */
  ping(options: { timeoutMs: number }): Promise<void>
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
    // Detect peers that vanished without closing the connection (e.g. failover).
    keepAlive: true,
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
    async ping({ timeoutMs }) {
      // `query_timeout` is a per-query option of node-postgres (lib/client.js)
      // that @types/pg does not declare. On timeout the query fails, `pool.query`
      // releases the client with the error and the pool destroys it, so a
      // stalled database cannot exhaust the pool through repeated health checks.
      const query: pg.QueryConfig & { query_timeout: number } = {
        text: 'select 1',
        query_timeout: timeoutMs,
      }
      await pool.query(query)
    },
    async close() {
      await pool.end()
    },
  }
}
