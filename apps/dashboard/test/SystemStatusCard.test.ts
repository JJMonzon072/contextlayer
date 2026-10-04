import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SystemStatusCard from '../src/features/system-status/SystemStatusCard.vue'

const healthyReport = {
  status: 'ok',
  service: 'contextlayer-api',
  version: '1.4.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 3,
  checks: { database: { status: 'up', latencyMs: 7 } },
}

function respondWith(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  )
}

describe('SystemStatusCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the API and database as operational', async () => {
    respondWith(healthyReport)

    const wrapper = mount(SystemStatusCard)
    await flushPromises()

    expect(wrapper.get('[data-testid="api-status"]').text()).toBe('Operational')
    expect(wrapper.get('[data-testid="database-status"]').text()).toBe('Up · 7 ms')
    expect(wrapper.text()).toContain('1.4.0')
  })

  it('shows a degraded API when the database is down', async () => {
    respondWith(
      {
        ...healthyReport,
        status: 'unavailable',
        checks: { database: { status: 'down', latencyMs: 1 } },
      },
      503,
    )

    const wrapper = mount(SystemStatusCard)
    await flushPromises()

    expect(wrapper.get('[data-testid="api-status"]').text()).toBe('Degraded')
    expect(wrapper.get('[data-testid="database-status"]').text()).toBe('Down')
  })

  it('announces an error when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    const wrapper = mount(SystemStatusCard)
    await flushPromises()

    expect(wrapper.get('[data-testid="api-status"]').text()).toBe('Unreachable')
    expect(wrapper.get('[role="alert"]').text()).toContain('could not be reached')
  })
})
