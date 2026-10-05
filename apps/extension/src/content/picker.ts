import { roleOf } from './capture/accessible'
import { promote } from './capture/descriptor'
import type { Overlay } from './overlay'

/**
 * Element picker for Edit Mode (Phase 5). While it runs, the author's pointer
 * highlights the element under it and one click selects it, without the page
 * reacting to that click: no handler, no link, no form submit, no focus
 * change. Escape cancels; Tab moves the focus and Enter selects the focused
 * element, for keyboard users.
 *
 * How the page is kept from reacting: listeners on `window` in the capture
 * phase, registered when the picker starts, call `preventDefault()` and
 * `stopImmediatePropagation()` on pointer, mouse, touch, click, submit and
 * key events, so the event never reaches the page's own listeners or default
 * action. Limit: a page that registered a capture listener on `window` before
 * the picker started still sees the event first. The picker runs in the
 * content script's isolated world, patches no prototype and adds no attribute
 * to the page; every listener, frame and timer is removed on stop.
 *
 * Events the page itself dispatches (`isTrusted === false`) never select or
 * cancel anything. Hover work is bounded: one hit test and one promotion per
 * animation frame, and the full descriptor is only built for the selected
 * element (by the caller).
 */

export type PickerCancelReason = 'escape' | 'timeout'

export interface PickerDeps {
  window: Window
  overlay: Overlay
  ttlMs: number
  /** False once the extension context is gone (reload or update): the picker stops silently. */
  isAlive: () => boolean
  /** Elements at a viewport point, topmost first (`document.elementsFromPoint`). */
  hitTest?: (x: number, y: number) => Element[]
  onPick: (element: Element) => void
  onCancel: (reason: PickerCancelReason) => void
  /** Whether the browser created the event; replaced in tests, since jsdom cannot create trusted events. */
  trusted?: (event: Event) => boolean
}

export interface Picker {
  stop(): void
}

const BLOCKED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'touchstart',
  'touchend',
  'dragstart',
  'submit',
  'keypress',
  'keyup',
] as const

export const PICKER_BANNER = 'Click an element to select it for this step. Press Esc to cancel.'

/** The short label shown next to the highlight: tag and role, nothing from the page's text. */
function describe(element: Element): string {
  const role = roleOf(element)
  return role && role !== element.localName ? `${element.localName} · ${role}` : element.localName
}

export function startPicker(deps: PickerDeps): Picker {
  const { window, overlay } = deps
  const document = window.document
  const hitTest = deps.hitTest ?? ((x, y) => document.elementsFromPoint(x, y))
  const trusted = deps.trusted ?? ((event: Event) => event.isTrusted)
  const listen = { capture: true, passive: false } as const
  let stopped = false
  let frame: number | undefined
  let pointer: { x: number; y: number } | undefined
  let current: Element | undefined
  // A picker the author walked away from does not stay on the page.
  const timer = setTimeout(() => {
    cancel('timeout')
  }, deps.ttlMs)

  /** The page element at a point: our own host is never a candidate. */
  function pageElementAt(x: number, y: number): Element | undefined {
    return hitTest(x, y).find((element) => !overlay.isOwn(element))
  }

  function draw() {
    frame = undefined
    if (stopped) return
    if (pointer) {
      const hit = pageElementAt(pointer.x, pointer.y)
      current = hit && promote(hit).element
    }
    if (!current?.isConnected) {
      current = undefined
      overlay.highlight(null)
      return
    }
    const rect = current.getBoundingClientRect()
    overlay.highlight(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      describe(current),
    )
  }

  function schedule() {
    frame ??= window.requestAnimationFrame(draw)
  }

  function finish(): boolean {
    if (stopped) return false
    stop()
    return deps.isAlive()
  }

  function pick(element: Element) {
    if (finish()) deps.onPick(element)
  }

  function cancel(reason: PickerCancelReason) {
    if (finish()) deps.onCancel(reason)
  }

  /** Every pointer, click and key event: the page never sees it while picking. */
  function block(event: Event) {
    if (!deps.isAlive()) {
      stop()
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!trusted(event) || event.type !== 'click') return
    const click = event as MouseEvent
    if (click.button !== 0) return
    const hit = pageElementAt(click.clientX, click.clientY)
    if (hit) pick(hit)
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!deps.isAlive()) {
      stop()
      return
    }
    // Tab moves the focus as usual, so keyboard users can reach an element.
    if (event.key === 'Tab') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!trusted(event)) return
    if (event.key === 'Escape') cancel('escape')
    else if (event.key === 'Enter') {
      const focused = document.activeElement
      if (focused && focused !== document.body && !overlay.isOwn(focused)) pick(focused)
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!trusted(event)) return
    pointer = { x: event.clientX, y: event.clientY }
    schedule()
  }

  function onFocusIn(event: FocusEvent) {
    const target = event.target
    if (!trusted(event) || !(target instanceof Element) || overlay.isOwn(target)) return
    pointer = undefined
    current = promote(target).element
    schedule()
  }

  function stop() {
    if (stopped) return
    stopped = true
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    clearTimeout(timer)
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, block, listen)
    window.removeEventListener('keydown', onKeyDown, listen)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('focusin', onFocusIn, true)
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule, true)
    overlay.highlight(null)
    overlay.banner(null)
  }

  for (const type of BLOCKED_EVENTS) window.addEventListener(type, block, listen)
  window.addEventListener('keydown', onKeyDown, listen)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('focusin', onFocusIn, true)
  // Layout moves under a still pointer: redraw the box, never poll.
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule, true)
  overlay.banner(PICKER_BANNER)

  return { stop }
}
