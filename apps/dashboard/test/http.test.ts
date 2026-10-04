import { healthReportSchema } from '@contextlayer/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getJson, HttpError } from '../src/lib/http'

const report = {
  status: 'ok',
  service: 'contextlayer-api',
  version: '0.0.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 3,
  checks: { database: { status: 'up', latencyMs: 2 } },
}

function stubFetch(implementation: () => Promise<Response>) {
  const fetchMock = vi.fn(implementation)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

describe('getJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the path through the same-origin /api prefix', async () => {
    const fetchMock = stubFetch(() => json(report))

    await getJson('/health', healthReportSchema)

    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.any(Object))
  })

  it('returns the parsed body for accepted statuses', async () => {
    stubFetch(() => json({ ...report, status: 'unavailable' }, 503))

    const result = await getJson('/health', healthReportSchema, { acceptedStatuses: [200, 503] })

    expect(result.status).toBe('unavailable')
  })

  it('rejects unexpected statuses with a status error', async () => {
    stubFetch(() => json({}, 502))

    await expect(getJson('/health', healthReportSchema)).rejects.toMatchObject({
      kind: 'status',
      status: 502,
    })
  })

  it('rejects bodies that break the contract', async () => {
    stubFetch(() => json({ ...report, service: 'something-else' }))

    await expect(getJson('/health', healthReportSchema)).rejects.toMatchObject({
      kind: 'invalid-response',
    })
  })

  it('treats a 5xx whose body is not ours as a status error, not contract drift', async () => {
    // Fastify's own body while it is shutting down.
    stubFetch(() =>
      json({ error: 'Service Unavailable', message: 'Service Unavailable', statusCode: 503 }, 503),
    )

    await expect(
      getJson('/health', healthReportSchema, { acceptedStatuses: [200, 503] }),
    ).rejects.toMatchObject({ kind: 'status', status: 503 })
  })

  it('treats a non-JSON 5xx page from a proxy as a status error', async () => {
    stubFetch(() =>
      Promise.resolve(new Response('<html>Service Unavailable</html>', { status: 503 })),
    )

    await expect(
      getJson('/health', healthReportSchema, { acceptedStatuses: [200, 503] }),
    ).rejects.toMatchObject({ kind: 'status', status: 503 })
  })

  it('wraps network failures', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    const error: unknown = await getJson('/health', healthReportSchema).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ kind: 'network' })
  })
})
