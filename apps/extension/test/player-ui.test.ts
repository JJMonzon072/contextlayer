import type { TargetDescriptor } from '@contextlayer/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { captureTarget } from '../src/content/capture/descriptor'
import type { HighlightRect, Overlay } from '../src/content/overlay'
import { createPlayer, ENDED_TEXT, HINTS, STALE_TEXT } from '../src/content/player/player'
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
  for (let round = 0; round < 12; round += 1) {
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

/** An overlay that records what it draws, with the card in a closed shadow root like ours. */
function setup(options: { trusted?: boolean } = {}) {
  const host = document.createElement('div')
  host.setAttribute('data-test-host', '')
  document.documentElement.append(host)
  const root = host.attachShadow({ mode: 'closed' })
  const card = document.createElement('div')
  card.setAttribute('role', 'dialog')
  root.append(card)
  let open = false
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
    const target = capture('#rows li:nth-of-type(2) button')

    ui.player.show(step(0, { target }))
    await settle()

    expect(ui.card.dataset.outcome).toBe('ambiguous')
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
    expect(ui.text('.hint')).toBe(HINTS.ambiguous)
    expect(ui.part('.hint').hidden).toBe(false)
  })

  it('shows a target that is not on the page on its own, with a hint', async () => {
    const ui = setup()
    const target = capture('#new')
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
    const target = capture('#new')

    ui.player.show(step(0, { target }))
    document.querySelector('#new')?.remove()
    await settle()

    expect(ui.card.dataset.outcome).toBe('not-found')
    expect(ui.highlights.every((rect) => rect === null)).toBe(true)
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
    const target = capture('#new')
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
    const target = capture('#new')
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
