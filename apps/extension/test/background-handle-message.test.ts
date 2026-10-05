import type { HealthReport } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { classifySender, handleBackgroundMessage } from '../src/background/handle-message'

const report: HealthReport = {
  status: 'ok',
  service: 'contextlayer-api',
  version: '0.0.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 1,
  checks: { database: { status: 'up', latencyMs: 1 } },
}

const EXTENSION_ID = 'own-extension-id'
const popupSender = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` }
const contentScriptSender = {
  id: EXTENSION_ID,
  url: 'http://localhost:5173/',
  tab: { id: 7 } as chrome.tabs.Tab,
}

const status = {
  state: 'disconnected',
  connection: null,
  attemptPending: false,
  persistent: true,
  api: 'ok',
} as const

function deps(fetchApiHealth = vi.fn(() => Promise.resolve(report))) {
  return {
    extensionId: EXTENSION_ID,
    fetchApiHealth,
    onApiError: vi.fn(),
    connection: {
      status: vi.fn(() => Promise.resolve(status)),
      start: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve({ serverConfirmed: true })),
    },
  }
}

const PRIVILEGED = [
  'connection.status',
  'connection.start',
  'connection.cancel',
  'connection.disconnect',
] as const

describe('classifySender', () => {
  it('recognises extension pages by their own origin, even when opened in a tab', () => {
    expect(classifySender(popupSender, EXTENSION_ID)).toBe('extension-page')
    expect(
      classifySender({ ...popupSender, tab: { id: 3 } as chrome.tabs.Tab }, EXTENSION_ID),
    ).toBe('extension-page')
  })

  it('recognises content scripts as senders from a web page tab', () => {
    expect(classifySender(contentScriptSender, EXTENSION_ID)).toBe('content-script')
  })

  it('rejects other extensions and senders without a page or tab', () => {
    expect(classifySender({ ...popupSender, id: 'someone-else' }, EXTENSION_ID)).toBeUndefined()
    expect(classifySender({ id: EXTENSION_ID, url: 'https://evil.example/' }, EXTENSION_ID)).toBe(
      undefined,
    )
  })
})

describe('handleBackgroundMessage', () => {
  it('returns the API health report to the popup and to content scripts', async () => {
    for (const sender of [popupSender, contentScriptSender]) {
      const result = await handleBackgroundMessage({ type: 'api.health.get' }, sender, deps())

      expect(result).toEqual({ ok: true, data: report })
    }
  })

  it('maps API failures to API_UNREACHABLE and reports them', async () => {
    const failingDeps = deps(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))

    const result = await handleBackgroundMessage(
      { type: 'api.health.get' },
      popupSender,
      failingDeps,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'API_UNREACHABLE' } })
    expect(failingDeps.onApiError).toHaveBeenCalledOnce()
  })

  it('rejects messages from unrecognised senders', async () => {
    const result = await handleBackgroundMessage(
      { type: 'api.health.get' },
      { id: 'someone-else', url: 'chrome-extension://someone-else/page.html' },
      deps(),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('rejects unknown or malformed messages', async () => {
    const result = await handleBackgroundMessage({ type: 'guides.delete' }, popupSender, deps())

    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('runs connection commands for extension pages', async () => {
    const handlers = deps()

    expect(
      await handleBackgroundMessage({ type: 'connection.start' }, popupSender, handlers),
    ).toEqual({ ok: true, data: status })
    expect(
      await handleBackgroundMessage({ type: 'connection.disconnect' }, popupSender, handlers),
    ).toEqual({ ok: true, data: { serverConfirmed: true } })
    expect(handlers.connection.start).toHaveBeenCalledOnce()
    expect(handlers.connection.disconnect).toHaveBeenCalledOnce()
  })

  it('never runs privileged commands for content scripts', async () => {
    const handlers = deps()

    for (const type of PRIVILEGED) {
      const result = await handleBackgroundMessage({ type }, contentScriptSender, handlers)
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    for (const command of Object.values(handlers.connection)) {
      expect(command).not.toHaveBeenCalled()
    }
  })

  it('rejects extra fields instead of ignoring them', async () => {
    const result = await handleBackgroundMessage(
      { type: 'connection.start', url: 'https://evil.example/' },
      popupSender,
      deps(),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })
})
