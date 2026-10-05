import { healthReportSchema } from '@contextlayer/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getJson, HttpError, request } from '../src/lib/http'

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

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends JSON bodies same-origin, so the HttpOnly cookie travels with them', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })))

    await expect(request('POST', '/v1/auth/logout', { body: { a: 1 } })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: '{"a":1}',
        headers: expect.objectContaining({ 'content-type': 'application/json' }) as unknown,
      }),
    )
  })

  it('turns the API error envelope into a typed error', async () => {
    stubFetch(() =>
      json({ error: { code: 'CONFLICT', message: 'Already a member.', requestId: 'r1' } }, 409),
    )

    await expect(request('POST', '/v1/workspaces/x/members', { body: {} })).rejects.toMatchObject({
      kind: 'status',
      status: 409,
      code: 'CONFLICT',
      apiMessage: 'Already a member.',
    })
  })

  it('reads retry-after on 429 responses', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many' } }), {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
      ),
    )

    await expect(request('POST', '/v1/auth/login', { body: {} })).rejects.toMatchObject({
      retryAfterSeconds: 120,
    })
  })
})
