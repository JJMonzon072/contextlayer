import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HighlightRect, Overlay } from '../src/content/overlay'
import { PICKER_BANNER, startPicker, type PickerDeps } from '../src/content/picker'

/** An overlay that records what it was asked to draw (jsdom has no Popover API). */
function fakeOverlay(own: Element[] = []) {
  const drawn: { rect: HighlightRect | null; label: string | undefined }[] = []
  const banners: (string | null)[] = []
  const overlay: Overlay = {
    showToast: vi.fn(),
    highlight: (rect, label) => drawn.push({ rect, label }),
    banner: (text) => banners.push(text),
    isOwn: (node) => own.some((element) => element === node || element.contains(node)),
    destroy: vi.fn(),
  }
  return { overlay, drawn, banners }
}

let frames: FrameRequestCallback[] = []
/** Every picker a test started: one left listening would block the next test's events. */
const started: { stop(): void }[] = []
const runFrames = () => {
  const pending = frames
  frames = []
  for (const callback of pending) callback(0)
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    frames = []
  })
  document.body.innerHTML = `
    <form id="customer">
      <button type="submit" id="save"><span class="icon">✓</span> Save customer</button>
      <a href="#elsewhere" id="link">Customers</a>
      <input id="name" aria-label="Name">
    </form>
    <div id="ours"></div>
  `
})

afterEach(() => {
  for (const instance of started.splice(0)) instance.stop()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames = []
})

const byId = (id: string) => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`#${id} missing`)
  return element
}
const icon = () => {
  const element = byId('save').querySelector('.icon')
  if (!element) throw new Error('.icon missing')
  return element
}

/** The page's own listeners, to prove they never run while picking. */
function pageListeners() {
  const seen: string[] = []
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'submit']) {
    document.addEventListener(type, () => seen.push(type))
    byId('save').addEventListener(type, () => seen.push(`save:${type}`))
  }
  return seen
}

function picker(overrides: Partial<PickerDeps> = {}) {
  const fake = fakeOverlay([byId('ours')])
  const onPick = vi.fn()
  const onCancel = vi.fn()
  let hits: Element[] = []
  const instance = startPicker({
    window,
    overlay: fake.overlay,
    ttlMs: 120_000,
    isAlive: () => true,
    hitTest: () => hits,
    onPick,
    onCancel,
    trusted: () => true,
    ...overrides,
  })
  started.push(instance)
  return {
    ...fake,
    instance,
    onPick,
    onCancel,
    pointAt: (...elements: Element[]) => {
      hits = elements
    },
  }
}

const click = (target: Element) =>
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, composed: true }),
  )
const key = (target: Element, name: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))

describe('startPicker', () => {
  it('highlights the control under the pointer, once per frame, with a neutral label', () => {
    const { pointAt, drawn, banners } = picker()
    pointAt(icon(), byId('save'))

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 6, clientY: 6 }))
    expect(frames).toHaveLength(1)
    runFrames()

    expect(banners).toEqual([PICKER_BANNER])
    expect(drawn).toEqual([{ rect: { left: 0, top: 0, width: 0, height: 0 }, label: 'button' }])
  })

  it('selects with a click that the page never sees', () => {
    const seen = pageListeners()
    const { pointAt, onPick, drawn, banners } = picker()
    pointAt(icon())

    const notCancelled = click(byId('save'))

    expect(notCancelled).toBe(false)
    expect(seen).toEqual([])
    expect(onPick).toHaveBeenCalledWith(icon())
    // Stopped: highlight and banner removed, the page works again.
    expect(drawn.at(-1)).toEqual({ rect: null, label: undefined })
    expect(banners.at(-1)).toBeNull()
    click(byId('save'))
    expect(seen).toContain('save:click')
  })

  it('blocks presses, links and submits without selecting on them', () => {
    const seen = pageListeners()
    const { pointAt, onPick } = picker()
    pointAt(byId('link'))

    for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
      byId('save').dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    }
    byId('customer').dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    const linkFollowed = byId('link').dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    )

    expect(seen).toEqual([])
    expect(linkFollowed).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('ignores events the page dispatches itself', () => {
    const seen = pageListeners()
    const { pointAt, onPick, onCancel } = picker({ trusted: (event) => event.isTrusted })
    pointAt(byId('save'))

    click(byId('save'))
    key(byId('save'), 'Escape')

    // Still blocked from the page, but neither selects nor cancels.
    expect(seen).toEqual([])
    expect(onPick).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('never picks its own UI', () => {
    const { pointAt, onPick } = picker()
    pointAt(byId('ours'), byId('link'))

    click(byId('ours'))

    expect(onPick).toHaveBeenCalledWith(byId('link'))
  })

  it('cancels on Escape and lets the page have its keys back', () => {
    const seen = pageListeners()
    const { onCancel, onPick } = picker()

    key(byId('name'), 'a')
    key(byId('name'), 'Escape')
    key(byId('name'), 'b')

    expect(onCancel).toHaveBeenCalledWith('escape')
    expect(onPick).not.toHaveBeenCalled()
    expect(seen).toEqual(['keydown'])
  })

  it('lets keyboard users tab to an element and select it with Enter', () => {
    const { onPick, drawn } = picker()
    byId('link').focus()
    runFrames()

    expect(key(byId('link'), 'Tab')).toBe(true)
    key(byId('link'), 'Enter')

    expect(drawn[0]?.label).toBe('a · link')
    expect(onPick).toHaveBeenCalledWith(byId('link'))
  })

  it('gives up after its time limit', () => {
    vi.useFakeTimers()
    const { onCancel, banners } = picker({ ttlMs: 2_000 })

    vi.advanceTimersByTime(2_000)

    expect(onCancel).toHaveBeenCalledWith('timeout')
    expect(banners.at(-1)).toBeNull()
  })

  it('stops silently when the extension context is gone', () => {
    const seen = pageListeners()
    let alive = true
    const { pointAt, onPick, onCancel, banners } = picker({ isAlive: () => alive })
    pointAt(byId('save'))
    alive = false

    click(byId('save'))
    click(byId('save'))

    expect(onPick).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(banners.at(-1)).toBeNull()
    // The first event stops the orphaned picker; later ones reach the page.
    expect(seen).toContain('save:click')
  })

  it('stop() removes every listener and pending frame', () => {
    const seen = pageListeners()
    const { instance, pointAt, onPick } = picker()
    pointAt(byId('save'))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1, clientY: 1 }))

    instance.stop()
    instance.stop()
    click(byId('save'))

    expect(frames).toEqual([])
    expect(onPick).not.toHaveBeenCalled()
    expect(seen).toContain('save:click')
  })
})
