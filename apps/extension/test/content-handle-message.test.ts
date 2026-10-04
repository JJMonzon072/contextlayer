import type { HealthReport } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { handleContentMessage, type ContentDeps } from '../src/content/handle-message'
import { failure, success } from '../src/messaging/protocol'

const report: HealthReport = {
  status: 'ok',
  service: 'contextlayer-api',
  version: '0.0.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 1,
  checks: { database: { status: 'up', latencyMs: 1 } },
}

function deps(overrides: Partial<ContentDeps> = {}): ContentDeps {
  return {
    extensionVersion: '0.1.0',
    getPage: () => ({ url: 'http://localhost:4000/app', title: 'Target app' }),
    requestApiHealth: () => Promise.resolve(success(report)),
    showToast: vi.fn(),
    ...overrides,
  }
}

describe('handleContentMessage', () => {
  it('answers a ping with page details and the API status', async () => {
    const result = await handleContentMessage({ type: 'page.ping' }, deps())

    expect(result).toEqual({
      ok: true,
      data: {
        url: 'http://localhost:4000/app',
        title: 'Target app',
        extensionVersion: '0.1.0',
        api: 'ok',
      },
    })
  })

  it('reports a degraded API when the database is down', async () => {
    const degraded: HealthReport = {
      ...report,
      status: 'unavailable',
      checks: { database: { status: 'down', latencyMs: 2 } },
    }

    const result = await handleContentMessage(
      { type: 'page.ping' },
      deps({ requestApiHealth: () => Promise.resolve(success(degraded)) }),
    )

    expect(result).toMatchObject({ ok: true, data: { api: 'unavailable' } })
  })

  it('reports an unreachable API and tells the user on the page', async () => {
    const showToast = vi.fn()

    const result = await handleContentMessage(
      { type: 'page.ping' },
      deps({
        requestApiHealth: () => Promise.resolve(failure('API_UNREACHABLE', 'down')),
        showToast,
      }),
    )

    expect(result).toMatchObject({ ok: true, data: { api: 'unreachable' } })
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('unreachable'))
  })

  it('rejects unsupported messages', async () => {
    const result = await handleContentMessage({ type: 'page.delete-everything' }, deps())

    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })
})
