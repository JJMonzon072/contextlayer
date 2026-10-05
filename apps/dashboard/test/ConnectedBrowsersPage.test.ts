import type { Connection } from '@contextlayer/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ConnectedBrowsersPage from '../src/features/extension/ConnectedBrowsersPage.vue'
import * as extensionApi from '../src/features/extension/extension-api'
import { apiError, ACME } from './fixtures'

vi.mock('../src/features/extension/extension-api')

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: '01a10a2e-864b-75bc-8800-aa3f01a05350',
  label: 'Chrome on macOS',
  workspace: { id: ACME.id, name: ACME.name },
  status: 'active',
  createdAt: '2026-10-05T12:00:00.000Z',
  expiresAt: '2026-11-04T12:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  revokedReason: null,
  ...overrides,
})

async function mountPage() {
  const wrapper = mount(ConnectedBrowsersPage)
  await flushPromises()
  return wrapper
}

const button = (wrapper: Awaited<ReturnType<typeof mountPage>>, text: string) =>
  wrapper.findAll('button').find((candidate) => candidate.text().startsWith(text))

describe('ConnectedBrowsersPage', () => {
  beforeEach(() => {
    vi.mocked(extensionApi.listConnections).mockReset()
    vi.mocked(extensionApi.revokeConnection).mockReset()
  })

  it('lists connections with their workspace and status', async () => {
    vi.mocked(extensionApi.listConnections).mockResolvedValue([
      connection(),
      connection({
        id: '01a10a2e-864b-75bc-8800-aa3f01a05351',
        status: 'revoked',
        revokedAt: '2026-10-06T12:00:00.000Z',
        revokedReason: 'refresh-reuse',
      }),
    ])
    const wrapper = await mountPage()

    const rows = wrapper.findAll('[data-testid="connection-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('Chrome on macOS')
    expect(rows[0]?.text()).toContain('Acme')
    expect(rows.map((row) => row.get('[data-testid="connection-status"]').text())).toEqual([
      'Active',
      'Revoked',
    ])
    expect(rows[1]?.text()).toContain('a refresh token was used twice')
    expect(rows[1]?.find('button').exists()).toBe(false)
  })

  it('asks for confirmation, revokes and reloads', async () => {
    vi.mocked(extensionApi.listConnections)
      .mockResolvedValueOnce([connection()])
      .mockResolvedValueOnce([connection({ status: 'revoked', revokedReason: 'dashboard' })])
    vi.mocked(extensionApi.revokeConnection).mockResolvedValue(undefined)
    const wrapper = await mountPage()

    await button(wrapper, 'Revoke')?.trigger('click')
    expect(extensionApi.revokeConnection).not.toHaveBeenCalled()
    await button(wrapper, 'Confirm revoke')?.trigger('click')
    await flushPromises()

    expect(extensionApi.revokeConnection).toHaveBeenCalledWith(connection().id)
    expect(wrapper.get('[data-testid="notice"]').text()).toContain('was revoked')
    expect(wrapper.get('[data-testid="connection-status"]').text()).toBe('Revoked')
  })

  it('explains how to connect when nothing is connected, and shows errors', async () => {
    vi.mocked(extensionApi.listConnections).mockResolvedValueOnce([])
    expect((await mountPage()).text()).toContain('No browser is connected')

    vi.mocked(extensionApi.listConnections).mockRejectedValueOnce(
      apiError(500, 'INTERNAL_ERROR', 'Internal server error'),
    )
    expect((await mountPage()).get('[role="alert"]').text()).toMatch(/having trouble/)
  })
})
