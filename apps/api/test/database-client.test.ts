import net from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase } from '../src/infrastructure/database/client.js'

/**
 * Minimal PostgreSQL wire-protocol server that completes the startup handshake
 * and then never answers a query: a database that stalled without closing the
 * connection (e.g. a failover where the old primary vanished).
 */
function startStalledPostgres(): Promise<{
  port: number
  openSockets: () => number
  close: () => void
}> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => {
      const authenticationOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])
      const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49])
      socket.write(Buffer.concat([authenticationOk, readyForQuery]))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        openSockets: () => sockets.size,
        close: () => {
          for (const socket of sockets) socket.destroy()
          server.close()
        },
      })
    })
  })
}

describe('createDatabase().ping', () => {
  let stalled: Awaited<ReturnType<typeof startStalledPostgres>>

  beforeAll(async () => {
    stalled = await startStalledPostgres()
  })

  afterAll(() => {
    stalled.close()
  })

  it('times out and releases the connection, so repeated probes cannot exhaust the pool', async () => {
    const database = createDatabase({
      url: `postgres://user:pass@127.0.0.1:${stalled.port}/db`,
      logger: { error: () => undefined },
    })

    // More probes than the pool has connections (max 10).
    for (let probe = 0; probe < 12; probe++) {
      await expect(database.ping({ timeoutMs: 50 })).rejects.toThrow('Query read timeout')
    }

    // Timed-out clients are destroyed instead of staying checked out.
    await expect.poll(() => stalled.openSockets()).toBeLessThanOrEqual(1)
    await database.close()
  })
})
