import { apiErrorSchema, healthReportSchema } from '@contextlayer/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { createHealthService } from '../src/modules/health/health.service.js'

type App = Awaited<ReturnType<typeof buildApp>>

function fakeDatabase(ping: () => Promise<void>) {
  return { ping, close: vi.fn(() => Promise.resolve()) }
}

describe('health routes', () => {
  let app: App | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('GET /health answers 200 with a valid report when PostgreSQL is reachable', async () => {
    app = await buildApp({ database: fakeDatabase(() => Promise.resolve()) })

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    const report = healthReportSchema.parse(response.json())
    expect(report.status).toBe('ok')
    expect(report.checks.database.status).toBe('up')
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('GET /health answers 503 with the same contract when PostgreSQL is down', async () => {
    app = await buildApp({
      database: fakeDatabase(() => Promise.reject(new Error('connection refused'))),
    })

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    const report = healthReportSchema.parse(response.json())
    expect(report.status).toBe('unavailable')
    expect(report.checks.database.status).toBe('down')
  })

  it('GET /health/live answers 200 without touching dependencies', async () => {
    const ping = vi.fn(() => Promise.reject(new Error('should not be called')))
    app = await buildApp({ database: fakeDatabase(ping) })

    const response = await app.inject({ method: 'GET', url: '/health/live' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
    expect(ping).not.toHaveBeenCalled()
  })

  it('tags every response with an x-request-id header', async () => {
    app = await buildApp({ database: fakeDatabase(() => Promise.resolve()) })

    const response = await app.inject({ method: 'GET', url: '/health/live' })

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('closes the database when the app closes', async () => {
    const database = fakeDatabase(() => Promise.resolve())
    const closingApp = await buildApp({ database })

    await closingApp.close()

    expect(database.close).toHaveBeenCalledOnce()
  })
})

describe('error handling', () => {
  let app: App | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns the shared error envelope for unknown routes', async () => {
    app = await buildApp({ database: fakeDatabase(() => Promise.resolve()) })

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' })

    expect(response.statusCode).toBe(404)
    const body = apiErrorSchema.parse(response.json())
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.requestId).toBe(response.headers['x-request-id'])
  })

  it('hides internal error details from clients', async () => {
    app = await buildApp({ database: fakeDatabase(() => Promise.resolve()) })
    app.get('/boom', () => {
      throw new Error('secret stack detail')
    })

    const response = await app.inject({ method: 'GET', url: '/boom' })

    expect(response.statusCode).toBe(500)
    const body = apiErrorSchema.parse(response.json())
    expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
    expect(response.body).not.toContain('secret stack detail')
  })

  it('preserves 503 so clients can tell "try later" from a crash', async () => {
    app = await buildApp({ database: fakeDatabase(() => Promise.resolve()) })
    app.get('/busy', () => {
      throw Object.assign(new Error('pool exhausted on 10.0.0.5'), { statusCode: 503 })
    })

    const response = await app.inject({ method: 'GET', url: '/busy' })

    expect(response.statusCode).toBe(503)
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('SERVICE_UNAVAILABLE')
    expect(response.body).not.toContain('10.0.0.5')
  })

  it('replaces the message of non-Fastify client errors with a generic one', async () => {
    app = await buildApp({ database: fakeDatabase(() => Promise.resolve()) })
    app.get('/denied', () => {
      throw Object.assign(new Error('user 42 missing from workspace_members'), { statusCode: 403 })
    })

    const response = await app.inject({ method: 'GET', url: '/denied' })

    expect(response.statusCode).toBe(403)
    expect(apiErrorSchema.parse(response.json()).error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Forbidden',
    })
  })

  it("keeps Fastify's own client error messages", async () => {
    app = await buildApp({ database: fakeDatabase(() => Promise.resolve()) })
    app.post('/echo', () => ({}))

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })

    expect(response.statusCode).toBe(400)
    expect(apiErrorSchema.parse(response.json()).error.message).toMatch(/JSON/)
  })
})

describe('createHealthService', () => {
  const logger = { warn: vi.fn() }

  it('reports a dependency as down when its probe exceeds the timeout', async () => {
    const service = createHealthService({
      probes: { database: () => new Promise(() => undefined) },
      version: '1.2.3',
      logger,
      timeoutMs: 10,
      now: () => new Date('2026-10-04T12:00:00.000Z'),
      uptimeSeconds: () => 42.4,
    })

    const report = await service.getReport()

    expect(report).toMatchObject({
      status: 'unavailable',
      version: '1.2.3',
      timestamp: '2026-10-04T12:00:00.000Z',
      uptimeSeconds: 42,
      checks: { database: { status: 'down' } },
    })
    expect(logger.warn).toHaveBeenCalledOnce()
  })
})
