import type { TargetDescriptor } from '@contextlayer/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { captureTarget } from '../src/content/capture/descriptor'
import type { HighlightRect, Overlay } from '../src/content/overlay'
import {
  CHECK_INTERVAL_MS,
  createPlayer,
  GRACE_MS,
  ENDED_TEXT,
  HINTS,
  STALE_TEXT,
} from '../src/content/player/player'
import type { PlayerStep } from '../src/messaging/protocol'

/**
 * The Guide Player's card and highlight on a page (jsdom: no layout, no
 * Popover API, only untrusted events, so the overlay is a recording fake with
 * a real closed shadow root, and trust and visibility are injected). Real
 * geometry, focus and the top layer are covered by the Playwright suite.
 */

const RUN = 'Rn1_run-id-0123456789abcdef'
const OTHER_RUN = 'Rn2_run-id-0123456789abcdef'

const TITLES = ['Open the form', 'Type the name', 'Save the customer']

let frames: FrameRequestCallback[] = []
let scrollIntoView = vi.fn()
const runFrames = () => {
  const pending = frames
  frames = []
  for (const callback of pending) callback(0)
}
/** Lets the player's frames and awaited answers run. */
async function settle() {
  for (let round = 0; round < 30; round += 1) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const isRendered = (element: Element) =>
  element.isConnected && !element.closest('[hidden], [inert]')

/** What the page itself receives: the player must never click, type or submit for the user. */
let pageEvents: string[] = []
const recordPageEvent = (event: Event) => pageEvents.push(event.type)
const PAGE_EVENTS = ['click', 'submit', 'input', 'change', 'keydown', 'pointerdown']

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList)
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
  document.elementFromPoint = vi.fn(() => null)
  document.body.innerHTML = `
    <main>
      <h1>Customers</h1>
      <button type="button" id="new" data-testid="new-customer">New customer</button>
      <form id="customer-form" aria-label="New customer">
        <label for="name">Name</label><input id="name" name="name">
        <button type="submit" id="save">Save customer</button>
      </form>
      <ul id="rows">
        <li>Ana Ejemplo <button type="button">Edit</button></li>
        <li>Luis Prueba <button type="button">Edit</button></li>
      </ul>
    </main>
  `
  pageEvents = []
  for (const type of PAGE_EVENTS) document.addEventListener(type, recordPageEvent)
})

afterEach(() => {
  for (const type of PAGE_EVENTS) document.removeEventListener(type, recordPageEvent)
  vi.restoreAllMocks()
  frames = []
  for (const host of document.querySelectorAll('[data-test-host]')) host.remove()
})

function capture(selector: string): TargetDescriptor {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`No element for ${selector}`)
  const outcome = captureTarget(element, {
    extensionVersion: '0.1.0',
    capturedAt: new Date('2026-10-06T10:00:00Z'),
    href: window.location.href,
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.descriptor
}

function step(index: number, overrides: Partial<PlayerStep> = {}): PlayerStep {
  return {
    runId: RUN,
    generation: index,
    guideTitle: 'Create a customer',
    index,
    count: 3,
    title: TITLES[index] ?? 'Step',
    lines: [`Instructions ${String(index + 1)}`],
    target: null,
    urlPattern: null,
    placement: 'auto',
    ...overrides,
  }
}

/** The same target, with a descriptor that does not wait (`timeoutMs: 0`). */
function noWait(target: TargetDescriptor): TargetDescriptor {
  return { ...target, resolution: { ...target.resolution, timeoutMs: 0 } }
}

/** An overlay that records what it draws, with the card in a closed shadow root like ours. */
function setup(options: { trusted?: boolean; modal?: () => Element | null } = {}) {
  const host = document.createElement('div')
  host.setAttribute('data-test-host', '')
  document.documentElement.append(host)
  const root = host.attachShadow({ mode: 'closed' })
  const card = document.createElement('div')
  card.setAttribute('role', 'dialog')
  root.append(card)
  let open = false
  /** Where the overlay was asked to live (null: documentElement). */
  let container: Element | null = null
  let moves = 0
  const highlights: (HighlightRect | null)[] = []
  const toasts: string[] = []
  const overlay: Overlay = {
    showToast: (text) => toasts.push(text),
    highlight: (rect) => highlights.push(rect),
    banner: vi.fn(),
    callout: vi.fn(),
    isOwn: (node) => node === host || host.contains(node),
    destroy: vi.fn(),
    playerCard: () => card,
    showPlayerCard: () => {
      open = true
    },
    hidePlayerCard: () => {
      open = false
    },
    setContainer: (next) => {
      if (next === container) return false
      container = next
      moves += 1
      // Moving the host closes its popovers.
      open = false
      return true
    },
  }
  const sent: Record<string, unknown>[] = []
  let reply: (message: Record<string, unknown>) => unknown = () => ({
    ok: true,
    data: { done: true },
  })
  const player = createPlayer({
    window,
    overlay,
    send: (message) => {
      sent.push(message as Record<string, unknown>)
      return Promise.resolve(reply(message as Record<string, unknown>))
    },
    isRendered,
    ...(options.trusted !== false && { isTrusted: () => true }),
    ...(options.modal && { modal: options.modal }),
  })
  const part = (selector: string) => {
    const found = card.querySelector<HTMLElement>(selector)
    if (!found) throw new Error(`No ${selector} in the card`)
    return found
  }
  return {
    player,
    card,
    root,
    sent,
    highlights,
    toasts,
    isOpen: () => open,
    container: () => container,
    moves: () => moves,
    part,
    text: (selector: string) => part(selector).textContent,
    button: (name: string) => {
      const found = [...card.querySelectorAll('button')].find(
        (button) => (button.getAttribute('aria-label') ?? button.textContent) === name,
      )
      if (!found) throw new Error(`No ${name} button`)
      return found
    },
    replyWith(next: (message: Record<string, unknown>) => unknown) {
      reply = next
    },
    /** The last highlight drawn is a box (not cleared). */
    anchored: () => (highlights.at(-1) ?? null) !== null,
  }
}

describe('showing a step', () => {
  it('fills a labelled dialog with the guide, the progress and the step', async () => {
    const ui = setup()
    const target = capture('#new')

    expect(ui.player.show(step(0, { target }))).toBe(true)
    await settle()

    expect(ui.isOpen()).toBe(true)
    expect(ui.text('.context')).toBe('Create a customer')
    expect(ui.text('.progress')).toBe('Step 1 of 3')
    expect(ui.text('.title')).toBe('Open the form')
    expect(ui.text('.body')).toBe('Instructions 1')
    expect(ui.part('.hint').hidden).toBe(true)
    expect(ui.card.getAttribute('aria-labelledby')).toBe(ui.part('.title').id)
    expect(ui.card.getAttribute('aria-describedby')).toBe(ui.part('.body').id)
    expect(ui.part('[aria-live="polite"]').textContent).toBe('Step 1 of 3: Open the form')
    expect(ui.button('Previous').getAttribute('aria-disabled')).toBe('true')
    expect(ui.button('Next').getAttribute('aria-disabled')).toBe('false')
    expect(ui.button('Close guide').textContent).toBe('×')
    expect(ui.card.dataset.outcome).toBe('resolved')
    expect(ui.anchored()).toBe(true)
  })

  it('shows a step without a target on its own, without a hint', async () => {
    const ui = setup()

    ui.player.show(step(0))
    await settle()

    expect(ui.card.dataset.outcome).toBe('none')
    expect(ui.part('.hint').hidden).toBe(true)
    expect(ui.anchored()).toBe(false)
    expect(ui.card.dataset.side).toBe('none')
  })

  it('never anchors an ambiguous target, and says why', async () => {
    const ui = setup()
    const target = noWait(capture('#rows li:nth-of-type(2) button'))

    ui.player.show(step(0, { target }))
    await settle()

    expect(ui.card.dataset.outcome).toBe('ambiguous')
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
    expect(ui.text('.hint')).toBe(HINTS.ambiguous)
    expect(ui.part('.hint').hidden).toBe(false)
  })

  it('shows a target that is not on the page on its own, with a hint', async () => {
    const ui = setup()
    const target = noWait(capture('#new'))
    document.querySelector('#new')?.remove()

    ui.player.show(step(0, { target }))
    await settle()

    expect(ui.card.dataset.outcome).toBe('not-found')
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
    expect(ui.text('.hint')).toBe(HINTS['not-found'])
  })

  it('gives a safe hint for a step of another page', async () => {
    const ui = setup()
    const target = capture('#new')

    ui.player.show(step(0, { target, urlPattern: { pathname: '/reports' } }))
    await settle()

    expect(ui.card.dataset.outcome).toBe('wrong-page')
    expect(ui.text('.hint')).toBe(HINTS['wrong-page'])
    expect(ui.text('.hint')).not.toContain('/reports')
  })

  it('falls back to unanchored for a malformed target instead of guessing', async () => {
    const ui = setup()
    const target = { ...capture('#new'), locators: [{ strategy: 'nope' }] } as never

    ui.player.show(step(0, { target }))
    await settle()

    expect(['not-found', 'unsupported']).toContain(ui.card.dataset.outcome)
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
  })

  it('does not anchor a target that disappears before it holds still', async () => {
    const ui = setup()
    const target = noWait(capture('#new'))

    ui.player.show(step(0, { target }))
    document.querySelector('#new')?.remove()
    await settle()

    expect(ui.card.dataset.outcome).toBe('not-found')
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
  })

  it('never anchors a target that keeps moving, and shows the step on its own', async () => {
    const ui = setup()
    const target = noWait(capture('#new'))
    const moving = document.querySelector('#new')
    if (!moving) throw new Error('no button')
    let x = 0
    // A new box on every read: the target never holds still for two frames.
    vi.spyOn(moving, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ x: (x += 7), y: 40, width: 120, height: 32 }),
    )

    ui.player.show(step(0, { target }))
    await settle()

    expect(ui.isOpen()).toBe(true)
    expect(ui.card.dataset.outcome).toBe('not-found')
    expect(ui.card.dataset.side).toBe('none')
    expect(ui.text('.hint')).toBe(HINTS['not-found'])
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
    expect(ui.anchored()).toBe(false)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('anchors a target once it holds still, after moving for a while', async () => {
    const ui = setup()
    const target = capture('#new')
    const settling = document.querySelector('#new')
    if (!settling) throw new Error('no button')
    let reads = 0
    vi.spyOn(settling, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ x: Math.min((reads += 1), 3) * 10, y: 40, width: 120, height: 32 }),
    )

    ui.player.show(step(0, { target }))
    await settle()

    expect(ui.card.dataset.outcome).toBe('resolved')
    expect(ui.anchored()).toBe(true)
  })

  it('scrolls a target out of view into view, instantly under reduced motion', async () => {
    const ui = setup()
    const target = capture('#save')
    const save = document.querySelector('#save')
    if (!save) throw new Error('no save')
    vi.spyOn(save, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 5_000, width: 120, height: 32 }),
    )
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList)

    ui.player.show(step(0, { target }))
    await settle()

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    })
  })

  it('does not scroll a target already in view', async () => {
    const ui = setup()

    ui.player.show(step(0, { target: capture('#new') }))
    await settle()

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('marks an occluded target but still anchors it (a warning only)', async () => {
    const ui = setup()
    const cover = document.createElement('div')
    document.body.append(cover)
    document.elementFromPoint = vi.fn(() => cover)

    ui.player.show(step(0, { target: capture('#new') }))
    await settle()

    expect(ui.card.dataset.occluded).toBe('true')
    expect(ui.anchored()).toBe(true)
  })
})

describe('waiting for a target (Phase 6b)', () => {
  /** Observers the player started and has not disconnected. */
  let observing = 0

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    observing = 0
    // The originals, called with the observer as `this` below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { observe, disconnect } = MutationObserver.prototype
    vi.spyOn(MutationObserver.prototype, 'observe').mockImplementation(function (
      this: MutationObserver,
      ...args: Parameters<MutationObserver['observe']>
    ) {
      observing += 1
      observe.apply(this, args)
    })
    vi.spyOn(MutationObserver.prototype, 'disconnect').mockImplementation(function (
      this: MutationObserver,
    ) {
      observing -= 1
      disconnect.apply(this)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    history.replaceState(null, '', '/')
  })

  /** Lets `ms` of (fake) time pass, with frames, mutation callbacks and answers. */
  async function run(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 25) {
      runFrames()
      await vi.advanceTimersByTimeAsync(Math.min(25, ms - elapsed))
    }
    for (let round = 0; round < 6; round += 1) {
      runFrames()
      await vi.advanceTimersByTimeAsync(0)
    }
  }

  const newCustomer = () => {
    const button = document.createElement('button')
    button.type = 'button'
    button.id = 'new'
    button.dataset.testid = 'new-customer'
    button.textContent = 'New customer'
    return button
  }

  it('waits for a target that appears late, then anchors it', async () => {
    const ui = setup()
    const target = capture('#new')
    document.querySelector('#new')?.remove()

    ui.player.show(step(0, { target }))
    await run(0)
    expect(ui.card.dataset.state).toBe('waiting')
    expect(ui.text('.hint')).toBe(HINTS.waiting)
    expect(ui.anchored()).toBe(false)

    await run(500)
    document.querySelector('main')?.append(newCustomer())
    await run(CHECK_INTERVAL_MS * 2)

    expect(ui.card.dataset.state).toBe('anchored')
    expect(ui.card.dataset.outcome).toBe('resolved')
    expect(ui.part('.hint').hidden).toBe(true)
    expect(ui.anchored()).toBe(true)
  })

  it('still anchors a target that appears just before the limit', async () => {
    const ui = setup()
    const target = capture('#new')
    document.querySelector('#new')?.remove()

    ui.player.show(step(0, { target }))
    await run(target.resolution.timeoutMs - 400)
    document.querySelector('main')?.append(newCustomer())
    await run(CHECK_INTERVAL_MS * 2)

    expect(ui.card.dataset.state).toBe('anchored')
  })

  it('gives up at the limit, applies the policy and stops observing', async () => {
    const ui = setup()
    const target = capture('#new')
    document.querySelector('#new')?.remove()

    ui.player.show(step(0, { target }))
    await run(target.resolution.timeoutMs - 50)
    expect(ui.card.dataset.state).toBe('waiting')
    await run(100)

    expect(ui.card.dataset.state).toBe('shown')
    expect(ui.card.dataset.outcome).toBe('not-found')
    expect(ui.text('.hint')).toBe(HINTS['not-found'])
    // A target arriving after the limit is not looked for any more.
    document.querySelector('main')?.append(newCustomer())
    await run(CHECK_INTERVAL_MS * 2)
    expect(ui.anchored()).toBe(false)
  })

  it('uses the limit the descriptor stores', async () => {
    const ui = setup()
    const captured = capture('#new')
    const target = { ...captured, resolution: { ...captured.resolution, timeoutMs: 1_000 } }
    document.querySelector('#new')?.remove()

    ui.player.show(step(0, { target }))
    await run(950)
    expect(ui.card.dataset.state).toBe('waiting')
    await run(100)

    expect(ui.card.dataset.state).toBe('shown')
  })

  it('anchors an ambiguous target once the page leaves a single match', async () => {
    const ui = setup()
    const target = capture('#rows li:nth-of-type(2) button')

    ui.player.show(step(0, { target }))
    await run(0)
    expect(ui.card.dataset.state).toBe('waiting')
    expect(ui.card.dataset.outcome).toBe('ambiguous')

    document.querySelector('#rows li:nth-of-type(1)')?.remove()
    await run(CHECK_INTERVAL_MS * 2)

    expect(ui.card.dataset.state).toBe('anchored')
    expect(ui.anchored()).toBe(true)
  })

  it('applies the ambiguity policy when the page stays ambiguous', async () => {
    const ui = setup()
    const target = capture('#rows li:nth-of-type(2) button')

    ui.player.show(step(0, { target }))
    await run(target.resolution.timeoutMs + 100)

    expect(ui.card.dataset.state).toBe('shown')
    expect(ui.card.dataset.outcome).toBe('ambiguous')
    expect(ui.text('.hint')).toBe(HINTS.ambiguous)
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
  })

  it('looks again at most once per interval, however many mutations come in', async () => {
    let looks = 0
    const host = document.createElement('div')
    host.setAttribute('data-test-host', '')
    document.documentElement.append(host)
    const card = document.createElement('div')
    host.attachShadow({ mode: 'closed' }).append(card)
    const player = createPlayer({
      window,
      overlay: {
        showToast: vi.fn(),
        highlight: vi.fn(),
        banner: vi.fn(),
        callout: vi.fn(),
        isOwn: () => false,
        destroy: vi.fn(),
        playerCard: () => card,
        showPlayerCard: vi.fn(),
        hidePlayerCard: vi.fn(),
        setContainer: vi.fn(() => false),
      },
      send: () => Promise.resolve({ ok: true, data: { done: true } }),
      isRendered: (element) => {
        looks += 1
        return isRendered(element)
      },
      isTrusted: () => true,
    })
    const target = capture('#new')
    document.querySelector('#new')?.setAttribute('hidden', '')
    player.show(step(0, { target }))
    await run(0)
    const before = looks

    // Forty mutations within one interval.
    for (let index = 0; index < 40; index += 1) {
      document.querySelector('main')?.setAttribute('data-tick', String(index))
      await vi.advanceTimersByTimeAsync(2)
    }
    await run(CHECK_INTERVAL_MS)

    // The first showing made one attempt (`before` checks); forty mutations make one more.
    expect(looks - before).toBe(before)
    player.stop()
  })

  it('never waits for a step without a target, nor for one it cannot reach', async () => {
    const none = setup()
    none.player.show(step(0))
    await run(0)
    expect(none.card.dataset.state).toBe('shown')
    none.player.stop()

    const framed = setup()
    framed.player.show(step(0, { target: { ...capture('#new'), framePath: [{ index: 0 }] } }))
    await run(0)
    expect(framed.card.dataset.state).toBe('shown')
    expect(framed.card.dataset.outcome).toBe('unsupported')
    // Watched only for modal dialogs: the page changing never makes it look again.
    expect(observing).toBe(1)
    document.querySelector('main')?.setAttribute('data-changed', 'yes')
    await run(CHECK_INTERVAL_MS * 2)
    expect(framed.card.dataset.state).toBe('shown')
  })

  /** Shows a step anchored to `#new` and returns it. */
  async function anchoredOnNew(ui: ReturnType<typeof setup>, target = capture('#new')) {
    ui.player.show(step(0, { target }))
    await run(0)
    expect(ui.card.dataset.state).toBe('anchored')
    return target
  }

  it('anchors the element a framework puts in place of the target', async () => {
    const ui = setup()
    await anchoredOnNew(ui)
    const old = document.querySelector('#new')
    const drawnBefore = ui.highlights.length

    // A re-render: the same button, a new node.
    const replacement = newCustomer()
    old?.replaceWith(replacement)
    await run(CHECK_INTERVAL_MS + 50)

    // The old highlight went first, then the new node was anchored.
    expect(ui.highlights.slice(drawnBefore)).toContain(null)
    expect(ui.card.dataset.state).toBe('anchored')
    expect(ui.anchored()).toBe(true)
    expect(old?.isConnected).toBe(false)
  })

  it('anchors the target again when it comes back within the grace period', async () => {
    const ui = setup()
    await anchoredOnNew(ui)
    const button = document.querySelector('#new')
    const parent = button?.parentElement

    button?.remove()
    await run(CHECK_INTERVAL_MS + 50)
    expect(ui.card.dataset.state).toBe('regaining')
    expect(ui.highlights.at(-1)).toBeNull()
    expect(ui.text('.hint')).toBe(HINTS.waiting)

    if (button) parent?.append(button)
    await run(GRACE_MS / 2)

    expect(ui.card.dataset.state).toBe('anchored')
  })

  it('shows the step on its own when the target does not come back, never skipping or ending', async () => {
    const ui = setup()
    const captured = capture('#new')
    const strict = {
      ...captured,
      resolution: { ...captured.resolution, onNotFound: 'end' as const },
    }
    await anchoredOnNew(ui, strict)

    document.querySelector('#new')?.remove()
    await run(GRACE_MS + CHECK_INTERVAL_MS * 2)

    expect(ui.card.dataset.state).toBe('shown')
    expect(ui.card.dataset.outcome).toBe('not-found')
    expect(ui.text('.hint')).toBe(HINTS['not-found'])
    expect(ui.highlights.at(-1)).toBeNull()
    expect(ui.isOpen()).toBe(true)
    expect(ui.sent).toEqual([])
  })

  it('looks again for a target that is hidden, and anchors it when shown', async () => {
    const ui = setup()
    await anchoredOnNew(ui)

    document.querySelector('#new')?.setAttribute('hidden', '')
    await run(CHECK_INTERVAL_MS + 50)
    expect(ui.card.dataset.state).toBe('regaining')
    document.querySelector('#new')?.removeAttribute('hidden')
    await run(CHECK_INTERVAL_MS * 2)

    expect(ui.card.dataset.state).toBe('anchored')
  })

  it('never looks again for longer than the descriptor allows', async () => {
    const ui = setup()
    const captured = capture('#new')
    const quick = { ...captured, resolution: { ...captured.resolution, timeoutMs: 400 } }
    await anchoredOnNew(ui, quick)

    document.querySelector('#new')?.remove()
    await run(CHECK_INTERVAL_MS + 450)

    expect(ui.card.dataset.state).toBe('shown')
  })

  it('never takes another element for the target that left', async () => {
    const ui = setup()
    await anchoredOnNew(ui)
    const other = document.createElement('button')
    other.type = 'button'
    other.textContent = 'New supplier'

    document.querySelector('#new')?.replaceWith(other)
    await run(GRACE_MS + CHECK_INTERVAL_MS * 2)

    expect(ui.card.dataset.state).toBe('shown')
    expect(ui.anchored()).toBe(false)
  })

  it('waits on another page for the user to navigate, then shows the step there', async () => {
    const ui = setup()
    const target = capture('#new')

    ui.player.show(step(1, { target, urlPattern: { pathname: '/customers/new' } }))
    await run(0)
    expect(ui.card.dataset.state).toBe('off-page')
    expect(ui.text('.hint')).toBe(HINTS['wrong-page'])
    expect(ui.text('.hint')).not.toContain('/customers')

    // The application changes its route (pushState), the page reports it.
    history.pushState(null, '', '/customers/new')
    ui.player.urlChanged()
    await run(0)

    expect(ui.card.dataset.state).toBe('anchored')
    expect(ui.text('.progress')).toBe('Step 2 of 3')
    expect(ui.sent).toEqual([])
  })

  it('follows replaceState and going back, keeping the same step', async () => {
    const ui = setup()
    const target = capture('#new')
    ui.player.show(step(1, { target, urlPattern: { pathname: '/customers' } }))
    await run(0)
    expect(ui.card.dataset.state).toBe('off-page')

    history.replaceState(null, '', '/customers')
    ui.player.urlChanged()
    await run(0)
    expect(ui.card.dataset.state).toBe('anchored')

    history.replaceState(null, '', '/reports')
    ui.player.urlChanged()
    await run(0)
    expect(ui.card.dataset.state).toBe('off-page')
    expect(ui.highlights.at(-1)).toBeNull()
    expect(ui.text('.progress')).toBe('Step 2 of 3')
  })

  it('stops a wait in progress when the URL changes', async () => {
    const ui = setup()
    const target = capture('#new')
    document.querySelector('#new')?.remove()
    ui.player.show(step(0, { target, urlPattern: { pathname: '/' } }))
    await run(0)
    expect(ui.card.dataset.state).toBe('waiting')
    expect(observing).toBe(1)

    history.pushState(null, '', '/elsewhere')
    ui.player.urlChanged()
    await run(target.resolution.timeoutMs)

    expect(ui.card.dataset.state).toBe('off-page')
    // The wait's observer was replaced, not added to.
    expect(observing).toBe(1)
    // The old wait's deadline did not apply any policy.
    expect(ui.isOpen()).toBe(true)
  })

  it('keeps an anchored step as it is when the URL changes within its page', async () => {
    const ui = setup()
    await anchoredOnNew(ui)
    const drawn = ui.highlights.length

    history.pushState(null, '', '/#details')
    ui.player.urlChanged()
    await run(0)

    expect(ui.card.dataset.state).toBe('anchored')
    expect(ui.highlights.slice(drawn)).not.toContain(null)
  })

  it('suspends for bfcache without ending the run, and shows it again when it comes back', async () => {
    const ui = setup()
    const target = capture('#new')
    document.querySelector('#new')?.remove()
    ui.player.show(step(1, { target }))
    await run(0)
    expect(observing).toBe(1)

    // pagehide (persisted): the UI and the wait go, nothing is sent.
    ui.player.suspend()
    expect(ui.isOpen()).toBe(false)
    expect(observing).toBe(0)
    expect(ui.sent).toEqual([])

    // pageshow (persisted): the worker gives the run back with the next generation.
    expect(ui.player.show(step(1, { target, generation: 2 }))).toBe(true)
    await run(0)
    expect(ui.isOpen()).toBe(true)
    expect(ui.text('.progress')).toBe('Step 2 of 3')
    expect(observing).toBe(1)
  })

  it('never brings back a run hidden while the document was in bfcache', async () => {
    const ui = setup()
    ui.player.show(step(0))
    await run(0)
    ui.player.suspend()

    // The guide ended elsewhere; the hide arrived for this document.
    ui.player.hide(RUN)

    expect(ui.player.show(step(0, { generation: 3 }))).toBe(false)
    expect(ui.isOpen()).toBe(false)
  })

  /** The modal dialog jsdom cannot show: an open `<dialog>` stands for it. */
  const openModal = () => document.querySelector('dialog[open]')

  it('moves the card into a modal dialog that opens, and back when it closes', async () => {
    const ui = setup({ modal: openModal })
    ui.player.show(step(0))
    await run(0)
    expect(ui.container()).toBeNull()

    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    dialog.textContent = 'Confirm'
    document.body.append(dialog)
    await run(CHECK_INTERVAL_MS * 2)

    expect(ui.container()).toBe(dialog)
    // Moving closed the popover; it was shown again on top.
    expect(ui.isOpen()).toBe(true)

    dialog.removeAttribute('open')
    await run(CHECK_INTERVAL_MS * 2)

    expect(ui.container()).toBeNull()
    expect(ui.isOpen()).toBe(true)
  })

  it('anchors the target inside an open modal dialog, never its copy behind it', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div role="dialog" aria-label="Customer"><button type="button">Save</button></div>
       <dialog open aria-label="Customer"><button type="button">Save</button></dialog>`,
    )
    const target = capture('dialog button')
    const ui = setup({ modal: openModal })

    ui.player.show(step(0, { target }))
    await run(0)

    expect(ui.card.dataset.state).toBe('anchored')
    expect(ui.container()).toBe(document.querySelector('dialog'))
  })

  it('looks again for a target a modal dialog shuts out, and anchors it when it closes', async () => {
    const ui = setup({ modal: openModal })
    await anchoredOnNew(ui)

    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    dialog.textContent = 'Are you sure?'
    document.body.append(dialog)
    await run(CHECK_INTERVAL_MS + 50)
    expect(ui.card.dataset.state).toBe('regaining')
    expect(ui.highlights.at(-1)).toBeNull()

    dialog.remove()
    await run(CHECK_INTERVAL_MS * 2)

    expect(ui.card.dataset.state).toBe('anchored')
    expect(ui.container()).toBeNull()
  })

  it('stops observing when the step changes, the guide ends, is hidden or stops', async () => {
    const target = capture('#new')
    document.querySelector('#new')?.remove()
    const cases: ((ui: ReturnType<typeof setup>) => void)[] = [
      (ui) => {
        ui.button('Close guide').click()
      },
      (ui) => {
        ui.player.hide(RUN)
      },
      (ui) => {
        ui.player.stop()
      },
    ]
    for (const finish of cases) {
      const ui = setup()
      ui.player.show(step(0, { target }))
      await run(0)
      expect(observing).toBe(1)
      finish(ui)
      await run(0)
      expect(observing).toBe(0)
      ui.player.stop()
    }

    // Another run replaces this one: its observer is the only one left.
    const replaced = setup()
    replaced.player.show(step(0, { target }))
    await run(0)
    replaced.player.show(step(0, { runId: OTHER_RUN }))
    await run(0)
    expect(observing).toBe(1)
    replaced.player.stop()
    expect(observing).toBe(0)

    // Next: the next step's wait replaces this one.
    const ui = setup()
    ui.replyWith(() => ({ ok: true, data: step(1, { target }) }))
    ui.player.show(step(0, { target }))
    await run(0)
    ui.button('Next').click()
    await run(0)
    expect(observing).toBe(1)
    expect(ui.text('.progress')).toBe('Step 2 of 3')
    ui.player.stop()
    expect(observing).toBe(0)
  })
})

describe('moving through the guide', () => {
  it('asks the worker for Next with the run and generation shown, and shows its answer', async () => {
    const ui = setup()
    ui.replyWith(() => ({ ok: true, data: step(1) }))
    ui.player.show(step(0))
    await settle()

    ui.button('Next').click()
    await settle()

    expect(ui.sent).toEqual([{ type: 'player.go', runId: RUN, generation: 0, direction: 'next' }])
    expect(ui.text('.progress')).toBe('Step 2 of 3')
    expect(ui.text('.title')).toBe('Type the name')
    expect(ui.button('Previous').getAttribute('aria-disabled')).toBe('false')
  })

  it('offers Finish on the last step, which ends the guide and removes everything', async () => {
    const ui = setup()
    ui.player.show(step(2, { target: capture('#save') }))
    await settle()

    expect(ui.button('Finish')).toBeDefined()
    ui.button('Finish').click()

    expect(ui.sent).toEqual([{ type: 'player.end', runId: RUN, reason: 'finished' }])
    expect(ui.isOpen()).toBe(false)
    expect(ui.highlights.at(-1)).toBeNull()
    expect(ui.player.runId).toBeUndefined()
  })

  it('does nothing for Previous on the first step', async () => {
    const ui = setup()
    ui.player.show(step(0))
    await settle()

    ui.button('Previous').click()
    await settle()

    expect(ui.sent).toEqual([])
  })

  it('sends one request at a time', async () => {
    const ui = setup()
    let answer: (value: unknown) => void = () => undefined
    ui.replyWith(() => new Promise((resolve) => (answer = resolve)))
    ui.player.show(step(0))
    await settle()

    ui.button('Next').click()
    ui.button('Next').click()
    await settle()

    expect(ui.sent).toHaveLength(1)
    expect(ui.card.getAttribute('aria-busy')).toBe('true')
    answer({ ok: true, data: step(1) })
    await settle()
    expect(ui.card.getAttribute('aria-busy')).toBe('false')
  })

  it('ignores an answer that arrives after the guide was closed', async () => {
    const ui = setup()
    let answer: (value: unknown) => void = () => undefined
    ui.replyWith((message) =>
      message.type === 'player.go'
        ? new Promise((resolve) => (answer = resolve))
        : { ok: true, data: { done: true } },
    )
    ui.player.show(step(0))
    await settle()

    ui.button('Next').click()
    ui.button('Close guide').click()
    answer({ ok: true, data: step(1) })
    await settle()

    expect(ui.isOpen()).toBe(false)
    expect(ui.player.runId).toBeUndefined()
    // And a late show for that run is refused: it never comes back.
    expect(ui.player.show(step(1))).toBe(false)
    expect(ui.isOpen()).toBe(false)
  })

  it('removes the guide when the worker says it is no longer playing', async () => {
    const ui = setup()
    ui.replyWith(() => ({ ok: false, error: { code: 'STALE', message: 'No.' } }))
    ui.player.show(step(0))
    await settle()

    ui.button('Next').click()
    await settle()

    expect(ui.isOpen()).toBe(false)
    expect(ui.toasts).toEqual([STALE_TEXT])
  })

  it('keeps the step and says so when the worker cannot be reached', async () => {
    const ui = setup()
    ui.replyWith(() => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Gone.' } }))
    ui.player.show(step(0))
    await settle()

    ui.button('Next').click()
    await settle()

    expect(ui.isOpen()).toBe(true)
    expect(ui.text('.hint')).toBe(HINTS.unreachable)
    expect(ui.text('.title')).toBe('Open the form')
  })

  it('ignores an older or repeated step of the same run', async () => {
    const ui = setup()
    ui.player.show(step(1))
    await settle()

    expect(ui.player.show(step(0))).toBe(true)
    await settle()

    expect(ui.text('.title')).toBe('Type the name')
  })

  it('replaces another run that was shown', async () => {
    const ui = setup()
    ui.player.show(step(1))
    await settle()

    ui.player.show(step(0, { runId: OTHER_RUN, guideTitle: 'Export reports' }))
    await settle()

    expect(ui.player.runId).toBe(OTHER_RUN)
    expect(ui.text('.context')).toBe('Export reports')
    expect(ui.text('.progress')).toBe('Step 1 of 3')
  })

  it('skips a step whose target cannot be shown when the descriptor says so', async () => {
    const ui = setup()
    const target = noWait(capture('#new'))
    document.querySelector('#new')?.remove()
    const skipping = {
      ...target,
      resolution: { ...target.resolution, onNotFound: 'skip' as const },
    }

    ui.player.show(step(0, { target: skipping }))
    await settle()

    expect(ui.sent).toEqual([{ type: 'player.go', runId: RUN, generation: 0, direction: 'next' }])
  })

  it('ends the guide when the descriptor says so', async () => {
    const ui = setup()
    const target = noWait(capture('#new'))
    document.querySelector('#new')?.remove()
    const ending = { ...target, resolution: { ...target.resolution, onNotFound: 'end' as const } }

    ui.player.show(step(0, { target: ending }))
    await settle()

    expect(ui.sent).toEqual([{ type: 'player.end', runId: RUN, reason: 'closed' }])
    expect(ui.isOpen()).toBe(false)
    expect(ui.toasts).toEqual([ENDED_TEXT])
  })
})

describe('closing, keyboard and focus', () => {
  it('closes with the Close button', async () => {
    const ui = setup()
    ui.player.show(step(1))
    await settle()

    ui.button('Close guide').click()

    expect(ui.sent).toEqual([{ type: 'player.end', runId: RUN, reason: 'closed' }])
    expect(ui.isOpen()).toBe(false)
  })

  it('closes with Escape inside the card, and leaves Escape elsewhere to the page', async () => {
    const ui = setup()
    ui.player.show(step(1))
    await settle()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(ui.isOpen()).toBe(true)

    ui.button('Next').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
    )
    expect(ui.sent).toEqual([{ type: 'player.end', runId: RUN, reason: 'closed' }])
    expect(ui.isOpen()).toBe(false)
  })

  it('ignores clicks and keys the page forges', async () => {
    const ui = setup({ trusted: false })
    ui.player.show(step(1))
    await settle()

    ui.button('Next').click()
    ui.button('Close guide').click()
    ui.button('Next').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    expect(ui.sent).toEqual([])
    expect(ui.isOpen()).toBe(true)
  })

  it('takes the focus for the card when the page has none', async () => {
    const ui = setup()

    ui.player.show(step(0))
    await settle()

    expect(ui.root.activeElement).toBe(ui.part('.title'))
  })

  it('never takes the focus from a field the user is in', async () => {
    const ui = setup()
    const name = document.querySelector<HTMLInputElement>('#name')
    name?.focus()

    ui.player.show(step(0, { target: capture('#name') }))
    await settle()

    expect(document.activeElement).toBe(name)
    expect(ui.root.activeElement).toBeNull()
  })

  it('keeps the focus on Next when the step changes', async () => {
    const ui = setup()
    ui.replyWith(() => ({ ok: true, data: step(1) }))
    ui.player.show(step(0))
    await settle()
    ui.button('Next').focus()

    ui.button('Next').click()
    await settle()

    expect(ui.root.activeElement).toBe(ui.button('Next'))
  })
})

describe('late messages never bring a guide back', () => {
  it('refuses a show that arrives after the hide of the same run', async () => {
    const ui = setup()

    ui.player.hide(RUN)
    expect(ui.player.show(step(0, { target: capture('#new') }))).toBe(false)
    await settle()

    expect(ui.isOpen()).toBe(false)
    expect(ui.highlights).toEqual([])
    expect(ui.player.runId).toBeUndefined()
    expect(ui.sent).toEqual([])
  })

  it('keeps the newer run when the older one is hidden before its late show', async () => {
    const ui = setup()

    // The worker replaced A with B on this tab: hide A, show B, then A's show comes late.
    ui.player.hide(RUN)
    expect(ui.player.show(step(0, { runId: OTHER_RUN, guideTitle: 'Export reports' }))).toBe(true)
    await settle()
    expect(ui.player.show(step(0))).toBe(false)
    await settle()

    expect(ui.player.runId).toBe(OTHER_RUN)
    expect(ui.text('.context')).toBe('Export reports')
    expect(ui.isOpen()).toBe(true)
  })

  it('refuses a run that Edit Mode removed, even a later step of it', async () => {
    const ui = setup()
    ui.player.show(step(0))
    await settle()

    // Edit Mode starts a selection or preview on this page.
    ui.player.stop()
    expect(ui.player.show(step(1))).toBe(false)
    await settle()

    expect(ui.isOpen()).toBe(false)
    expect(ui.player.runId).toBeUndefined()
  })

  it('still removes a run that is shown when its hide arrives', async () => {
    const ui = setup()
    ui.player.show(step(0, { target: capture('#new') }))
    await settle()

    ui.player.hide(RUN)

    expect(ui.isOpen()).toBe(false)
    expect(ui.highlights.at(-1)).toBeNull()
    expect(ui.player.show(step(1))).toBe(false)
  })

  it('remembers the most recent ended runs only', () => {
    const ui = setup()
    const runs = Array.from(
      { length: 21 },
      (_, index) => `Rn${String(index).padStart(2, '0')}_ended-run-0123456789`,
    )

    for (const runId of runs) ui.player.hide(runId)

    // The oldest of 21 is forgotten (20 are kept); the newest is still refused.
    expect(ui.player.show(step(0, { runId: runs.at(-1) ?? '' }))).toBe(false)
    expect(ui.player.show(step(0, { runId: runs[0] ?? '' }))).toBe(true)
  })
})

describe('what the page sees', () => {
  it('never receives a click, a key, an input or a submit from a whole guide', async () => {
    const ui = setup()
    let step2 = 0
    ui.replyWith((message) =>
      message.type === 'player.go'
        ? { ok: true, data: step(++step2, { target: step2 === 2 ? capture('#save') : null }) }
        : { ok: true, data: { done: true } },
    )
    const saved = vi.fn((event: Event) => {
      event.preventDefault()
    })
    document.querySelector('form')?.addEventListener('submit', saved)

    ui.player.show(step(0, { target: capture('#new') }))
    await settle()
    ui.button('Next').click()
    await settle()
    ui.button('Next').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    ui.button('Next').click()
    await settle()
    ui.button('Finish').click()

    expect(pageEvents).toEqual([])
    expect(saved).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLInputElement>('#name')?.value).toBe('')
  })

  it('removes the UI when the worker hides that run, not another one', async () => {
    const ui = setup()
    ui.player.show(step(0))
    await settle()

    ui.player.hide(OTHER_RUN)
    expect(ui.isOpen()).toBe(true)
    ui.player.hide(RUN)
    expect(ui.isOpen()).toBe(false)
    expect(ui.sent).toEqual([])
  })

  it('removes the UI without telling the worker when the script stops', async () => {
    const ui = setup()
    ui.player.show(step(0, { target: capture('#new') }))
    await settle()

    ui.player.stop()

    expect(ui.isOpen()).toBe(false)
    expect(ui.highlights.at(-1)).toBeNull()
    expect(ui.sent).toEqual([])
  })
})
