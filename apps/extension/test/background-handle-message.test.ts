import type { HealthReport } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { handleBackgroundMessage } from '../src/background/handle-message'

const report: HealthReport = {
  status: 'ok',
  service: 'contextlayer-api',
  version: '0.0.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 1,
  checks: { database: { status: 'up', latencyMs: 1 } },
}

const ownSender = { id: 'own-extension-id' }

function deps(fetchApiHealth = vi.fn(() => Promise.resolve(report))) {
  return { extensionId: 'own-extension-id', fetchApiHealth, onApiError: vi.fn() }
}

describe('handleBackgroundMessage', () => {
  it('returns the API health report', async () => {
    const result = await handleBackgroundMessage({ type: 'api.health.get' }, ownSender, deps())

    expect(result).toEqual({ ok: true, data: report })
  })

  it('maps API failures to API_UNREACHABLE and reports them', async () => {
    const failingDeps = deps(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))

    const result = await handleBackgroundMessage({ type: 'api.health.get' }, ownSender, failingDeps)

    expect(result).toMatchObject({ ok: false, error: { code: 'API_UNREACHABLE' } })
    expect(failingDeps.onApiError).toHaveBeenCalledOnce()
  })

  it('rejects messages from other extensions', async () => {
    const result = await handleBackgroundMessage(
      { type: 'api.health.get' },
      { id: 'someone-else' },
      deps(),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('rejects unknown or malformed messages', async () => {
    const result = await handleBackgroundMessage({ type: 'guides.delete' }, ownSender, deps())

    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })
})
