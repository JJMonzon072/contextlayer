import { describe, expect, it } from 'vitest'

import { checkExternalSender, CONNECT_PATH, type ExternalSender } from '../src/background/external'

const DASHBOARD = 'https://app.contextlayer.example'
const expected = { dashboardOrigin: DASHBOARD, tabId: 9 }

const sender = (overrides: Partial<ExternalSender> = {}): ExternalSender => ({
  origin: DASHBOARD,
  url: `${DASHBOARD}${CONNECT_PATH}?state=a&challenge=b`,
  frameId: 0,
  documentLifecycle: 'active',
  tab: { id: 9 } as chrome.tabs.Tab,
  ...overrides,
})

describe('checkExternalSender', () => {
  it('accepts the top frame of the connect page in the tab the attempt opened', () => {
    expect(checkExternalSender(sender(), expected)).toBeUndefined()
  })

  it('compares origins exactly', () => {
    for (const origin of [
      'https://app.contextlayer.example.evil.test',
      'https://evil.test',
      'http://app.contextlayer.example',
      'https://app.contextlayer.example:8443',
      undefined,
    ]) {
      expect(checkExternalSender(sender({ origin }), expected)).toBe('origin')
    }
  })

  it('refuses extensions, subframes, inactive documents, other tabs and other pages', () => {
    expect(checkExternalSender(sender({ id: 'abcdefghijklmnopabcdefghijklmnop' }), expected)).toBe(
      'extension',
    )
    expect(checkExternalSender(sender({ frameId: 1 }), expected)).toBe('frame')
    expect(checkExternalSender(sender({ frameId: undefined }), expected)).toBe('frame')
    expect(checkExternalSender(sender({ documentLifecycle: 'prerender' }), expected)).toBe(
      'document',
    )
    expect(checkExternalSender(sender({ tab: undefined }), expected)).toBe('tab')
    expect(checkExternalSender(sender(), { ...expected, tabId: null })).toBe('tab')
    expect(checkExternalSender(sender({ url: `${DASHBOARD}/workspaces` }), expected)).toBe('url')
    expect(
      checkExternalSender(sender({ url: 'https://evil.test/extension/connect' }), expected),
    ).toBe('url')
    expect(checkExternalSender(sender({ url: undefined }), expected)).toBe('url')
  })
})
