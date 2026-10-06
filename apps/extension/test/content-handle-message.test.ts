import { describe, expect, it, vi } from 'vitest'

import { handleContentMessage, type ContentDeps } from '../src/content/handle-message'

function deps(overrides: Partial<ContentDeps> = {}): ContentDeps {
  return {
    extensionVersion: '0.1.0',
    isActive: () => true,
    getPage: () => ({ url: 'http://localhost:4179/app', title: 'Target app' }),
    showToast: vi.fn(),
    stop: vi.fn(),
    startPicker: vi.fn(),
    stopPicker: vi.fn(),
    showPreview: vi.fn(() => true),
    hidePreview: vi.fn(),
    showPlayer: vi.fn(() => true),
    hidePlayer: vi.fn(),
    ...overrides,
  }
}

const POPUP = { fromWorker: false }
const WORKER = { fromWorker: true }
const CAPTURE = 'Zk3_q-9xYt2LmN8pQ4rS'

describe('handleContentMessage', () => {
  it('answers a ping with page details and shows that it is active', () => {
    const showToast = vi.fn()

    const result = handleContentMessage({ type: 'page.ping' }, POPUP, deps({ showToast }))

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
      POPUP,
      deps({ isActive: () => false, showToast }),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('stops when the extension says the site lost access', () => {
    const stop = vi.fn()

    expect(handleContentMessage({ type: 'page.deactivate' }, WORKER, deps({ stop }))).toEqual({
      ok: true,
      data: null,
    })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('rejects unsupported messages', () => {
    expect(handleContentMessage({ type: 'page.delete-everything' }, WORKER, deps())).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(handleContentMessage({ type: 'page.ping', extra: true }, WORKER, deps())).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
  })

  it('starts and stops the picker for the worker only', () => {
    const startPicker = vi.fn()
    const stopPicker = vi.fn()
    const start = { type: 'picker.start', captureId: CAPTURE, ttlMs: 120_000 }

    expect(handleContentMessage(start, POPUP, deps({ startPicker }))).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(startPicker).not.toHaveBeenCalled()

    expect(handleContentMessage(start, WORKER, deps({ startPicker }))).toEqual({
      ok: true,
      data: null,
    })
    expect(startPicker).toHaveBeenCalledWith(CAPTURE, 120_000)

    handleContentMessage({ type: 'picker.stop', captureId: CAPTURE }, WORKER, deps({ stopPicker }))
    expect(stopPicker).toHaveBeenCalledWith(CAPTURE)
  })

  it('never starts a picker on a page the worker did not authorize', () => {
    const startPicker = vi.fn()

    const result = handleContentMessage(
      { type: 'picker.start', captureId: CAPTURE, ttlMs: 2_000 },
      WORKER,
      deps({ isActive: () => false, startPicker }),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
    expect(startPicker).not.toHaveBeenCalled()
  })

  it('shows a preview for the worker only, and says when the element is gone', () => {
    const showPreview = vi.fn(() => false)
    const request = { type: 'preview.show', captureId: CAPTURE, title: 'Save', lines: ['Click.'] }

    expect(handleContentMessage(request, POPUP, deps({ showPreview }))).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(showPreview).not.toHaveBeenCalled()
    expect(handleContentMessage(request, WORKER, deps({ showPreview }))).toEqual({
      ok: true,
      data: { shown: false },
    })
    expect(showPreview).toHaveBeenCalledWith(CAPTURE, 'Save', ['Click.'])
  })

  it('plays a guide for the worker only, on a page it authorized', () => {
    const step = {
      runId: 'Rn1_run-id-0123456789abcdef',
      generation: 0,
      guideTitle: 'Create a customer',
      index: 0,
      count: 3,
      title: 'Open the form',
      lines: [],
      target: null,
      urlPattern: null,
      placement: 'auto',
    }
    const showPlayer = vi.fn(() => true)
    const hidePlayer = vi.fn()
    const show = { type: 'player.show', step }
    const hide = { type: 'player.hide', runId: step.runId }

    for (const request of [show, hide]) {
      expect(handleContentMessage(request, POPUP, deps({ showPlayer, hidePlayer }))).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      })
    }
    expect(
      handleContentMessage(show, WORKER, deps({ isActive: () => false, showPlayer })),
    ).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
    expect(showPlayer).not.toHaveBeenCalled()
    expect(hidePlayer).not.toHaveBeenCalled()

    expect(handleContentMessage(show, WORKER, deps({ showPlayer }))).toEqual({
      ok: true,
      data: { shown: true },
    })
    expect(showPlayer).toHaveBeenCalledWith(step)
    expect(handleContentMessage(hide, WORKER, deps({ hidePlayer }))).toEqual({
      ok: true,
      data: null,
    })
    expect(hidePlayer).toHaveBeenCalledWith(step.runId)
  })
})
