import { describe, expect, it, vi } from 'vitest'

import { handleContentMessage, type ContentDeps } from '../src/content/handle-message'

function deps(overrides: Partial<ContentDeps> = {}): ContentDeps {
  return {
    extensionVersion: '0.1.0',
    isActive: () => true,
    getPage: () => ({ url: 'http://localhost:4179/app', title: 'Target app' }),
    showToast: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  }
}

describe('handleContentMessage', () => {
  it('answers a ping with page details and shows that it is active', () => {
    const showToast = vi.fn()

    const result = handleContentMessage({ type: 'page.ping' }, deps({ showToast }))

    expect(result).toEqual({
      ok: true,
      data: { url: 'http://localhost:4179/app', title: 'Target app', extensionVersion: '0.1.0' },
    })
    expect(showToast).toHaveBeenCalledWith('ContextLayer is active on this page.')
  })

  it('stays silent until the worker authorized the page', () => {
    const showToast = vi.fn()

    const result = handleContentMessage(
      { type: 'page.ping' },
      deps({ isActive: () => false, showToast }),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('stops when the extension says the site lost access', () => {
    const stop = vi.fn()

    expect(handleContentMessage({ type: 'page.deactivate' }, deps({ stop }))).toEqual({
      ok: true,
      data: null,
    })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('rejects unsupported messages', () => {
    expect(handleContentMessage({ type: 'page.delete-everything' }, deps())).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(handleContentMessage({ type: 'page.ping', extra: true }, deps())).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
  })
})
