import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  browserLabel,
  EXTENSION_ID,
  externalRuntime,
  sendToExtension,
} from '../src/features/extension/extension-bridge'

const message = { type: 'connection.cancel', state: 's'.repeat(43) } as const

describe('extension bridge', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('targets the development extension id unless EXTENSION_ID is set', () => {
    expect(EXTENSION_ID).toBe(DEVELOPMENT_EXTENSION_ID)
  })

  it('finds chrome.runtime only when an extension exposes it to this origin', () => {
    expect(externalRuntime()).toBeUndefined()
    vi.stubGlobal('chrome', { runtime: {} })
    expect(externalRuntime()).toBeUndefined()
    vi.stubGlobal('chrome', { runtime: { sendMessage: () => Promise.resolve(undefined) } })
    expect(externalRuntime()).toBeDefined()
  })

  it('reports a missing extension without sending anything', async () => {
    expect(await sendToExtension(message, undefined)).toEqual({
      ok: false,
      error: 'extension-missing',
    })
  })

  it('gives up when the extension does not answer in time', async () => {
    vi.useFakeTimers()
    const pending = sendToExtension(
      message,
      { sendMessage: () => new Promise(() => undefined) },
      50,
    )
    await vi.advanceTimersByTimeAsync(50)

    expect(await pending).toEqual({ ok: false, error: 'no-answer' })
  })

  it('names the browser for the Connected browsers list', () => {
    expect(
      browserLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS')
    expect(
      browserLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0',
      ),
    ).toBe('Edge on Windows')
    expect(browserLabel('curl/8')).toBe('Browser')
  })
})
