import type { PlayerStep } from '../../messaging/protocol'
import { readStepAnswer } from '../messages'
import type { Overlay } from '../overlay'
import { isRendered, resolveTarget, stepPagePattern, type Resolution } from '../resolve/resolver'
import { inView, placeCard, type Box } from './position'

/**
 * The Guide Player on the page (Phase 6a): one step of one run at a time, in
 * the isolated overlay (ADR 0013). The worker decides which step is shown;
 * this module resolves its target (ADR 0014), highlights it and shows the
 * card, and sends Previous / Next / Finish / Close back as requests about the
 * run and generation it shows. It never clicks, types or acts on the page:
 * the highlight takes no pointer events and nothing here dispatches events
 * to page elements.
 *
 * Accessibility (R-16): the card is a labelled, non-modal dialog with native
 * buttons and a polite live region; it takes the focus only when nothing on
 * the page has it (never from a field the user is typing in), never traps
 * it, and Escape closes the guide only when the focus is inside the card.
 * There is no animation, and scrolling is instant under reduced motion.
 */

export const HINTS = {
  'not-found': "This step's element isn't on the page right now.",
  ambiguous: 'More than one element matches this step, so none is highlighted.',
  'wrong-page': 'This step is on another page of this site.',
  unsupported: "ContextLayer can't point at this step's element on this page yet.",
  unreachable: "ContextLayer couldn't be reached. Try again.",
} as const

export const ENDED_TEXT = 'This guide ended: a step could not be shown on this page.'
export const STALE_TEXT = 'This guide is no longer playing.'

/**
 * How many two-frame checks a target gets to hold still. One that is still
 * moving after the last check is never anchored: the step is shown as
 * `not-found` (reason `unstable`), under the descriptor's policy.
 */
const STABILITY_CHECKS = 5
const POINTER_EVENTS = [
  'click',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'touchstart',
  'touchend',
]
/**
 * Runs ended here or that the worker said to hide, shown or not yet: a later
 * `player.show` for one of them is refused. The most recent ones are kept.
 */
const MAX_ENDED = 20

export interface PlayerDeps {
  window: Window
  overlay: Overlay
  /** Sends a request to the worker and returns its answer (`askWorker`). */
  send: (message: object) => Promise<unknown>
  /** Replaced in tests: jsdom has no layout. */
  isRendered?: (element: Element) => boolean
  /** Replaced in tests: jsdom only creates untrusted events. */
  isTrusted?: (event: Event) => boolean
}

export interface Player {
  /** Shows this step of its run (replacing another run). False for a run ended here. */
  show(step: PlayerStep): boolean
  /** Removes the run's UI, if that run is the one shown (the worker ended it). */
  hide(runId: string): void
  /** Removes the UI without telling the worker (the script stops, Edit Mode starts). */
  stop(): void
  readonly runId: string | undefined
}

interface Parts {
  card: HTMLElement
  context: HTMLElement
  progress: HTMLElement
  title: HTMLElement
  body: HTMLElement
  hint: HTMLElement
  previous: HTMLButtonElement
  next: HTMLButtonElement
  live: HTMLElement
}

type Direction = 'next' | 'previous'

const px = (value: number) => `${String(Math.round(value))}px`
const boxOf = (element: Element): Box => {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}
const sameBox = (a: Box, b: Box) =>
  Math.abs(a.left - b.left) < 1 &&
  Math.abs(a.top - b.top) < 1 &&
  Math.abs(a.width - b.width) < 1 &&
  Math.abs(a.height - b.height) < 1

export function createPlayer(deps: PlayerDeps): Player {
  const { window, overlay } = deps
  const document = window.document
  const rendered = deps.isRendered ?? isRendered
  const trusted = deps.isTrusted ?? ((event: Event) => event.isTrusted)

  /** The step shown; replaced (a new object) on every step change. */
  let current: { step: PlayerStep } | undefined
  let parts: Parts | undefined
  let hint: string | undefined
  let busy = false
  let lastDirection: Direction = 'next'
  /** The element highlighted, while the step is anchored. */
  let anchor: Element | undefined
  let frame: number | undefined
  let renderToken = 0
  const ended = new Set<string>()

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve()
      })
    })

  function build(card: HTMLElement): Parts {
    const part = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
      const element = document.createElement(tag)
      element.className = className
      return element
    }
    const context = part('span', 'context')
    const progress = part('span', 'progress')
    const title = part('h2', 'title')
    title.id = 'cl-player-title'
    title.tabIndex = -1
    const body = part('div', 'body')
    body.id = 'cl-player-body'
    const hintPart = part('p', 'hint')
    hintPart.hidden = true
    const actions = part('div', 'actions')
    const previous = part('button', 'secondary')
    previous.type = 'button'
    previous.textContent = 'Previous'
    const next = part('button', 'primary')
    next.type = 'button'
    const close = part('button', 'close')
    close.type = 'button'
    close.textContent = '×'
    close.setAttribute('aria-label', 'Close guide')
    const live = part('p', 'hidden-text')
    live.setAttribute('aria-live', 'polite')
    actions.append(previous, next)

    const on = (button: HTMLElement, action: () => void) => {
      button.addEventListener('click', (event) => {
        if (trusted(event)) action()
      })
    }
    on(previous, () => void go('previous'))
    on(next, () => {
      const step = current?.step
      if (!step) return
      if (step.index === step.count - 1) end('finished')
      else void go('next')
    })
    on(close, () => {
      end('closed')
    })
    // Clicks in our card are not clicks on the page (a page menu that closes
    // on an outside click stays open). Page capture listeners still see them.
    for (const type of POINTER_EVENTS) {
      card.addEventListener(type, (event) => {
        event.stopPropagation()
      })
    }
    card.addEventListener('keydown', (event) => {
      if (trusted(event) && event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        end('closed')
      }
      // Keys typed in our card are not the page's shortcuts.
      event.stopPropagation()
    })
    card.setAttribute('aria-labelledby', title.id)
    card.setAttribute('aria-describedby', body.id)
    card.replaceChildren(context, progress, title, body, hintPart, actions, close, live)
    return { card, context, progress, title, body, hint: hintPart, previous, next, live }
  }

  /** The card, filled with the step shown (filled again if the page removed our host). */
  function ensureParts(): Parts {
    const card = overlay.playerCard()
    if (parts?.card !== card) {
      parts = build(card)
      if (current) fill(parts, current.step)
    }
    return parts
  }

  function fill(target: Parts, step: PlayerStep) {
    target.context.textContent = step.guideTitle
    target.progress.textContent = `Step ${String(step.index + 1)} of ${String(step.count)}`
    target.title.textContent = step.title
    target.body.replaceChildren(
      ...step.lines.map((line) => {
        const paragraph = document.createElement('p')
        paragraph.className = 'line'
        paragraph.textContent = line
        return paragraph
      }),
    )
    target.previous.setAttribute('aria-disabled', String(step.index === 0 || busy))
    target.next.setAttribute('aria-disabled', String(busy))
    target.next.textContent = step.index === step.count - 1 ? 'Finish' : 'Next'
    target.card.setAttribute('aria-busy', String(busy))
    target.hint.hidden = hint === undefined
    target.hint.textContent = hint ?? ''
  }

  function setHint(text: string | undefined) {
    hint = text
    if (current) fill(ensureParts(), current.step)
  }

  function setBusy(value: boolean) {
    busy = value
    if (current && parts) fill(parts, current.step)
  }

  /** Shows the card next to `target`, or on its own; measured after it is shown. */
  function place(target: Box | null) {
    const step = current?.step
    if (!step) return
    const { card } = ensureParts()
    overlay.showPlayerCard()
    const size = card.getBoundingClientRect()
    const { left, top, side } = placeCard(size, target, step.placement, viewport())
    card.style.left = px(left)
    card.style.top = px(top)
    card.dataset.side = side ?? 'none'
  }

  function draw() {
    frame = undefined
    if (!current) return
    if (anchor && !anchor.isConnected) {
      // Gone mid-step (re-resolving it is Phase 6b): shown on its own, with a hint.
      anchor = undefined
      overlay.highlight(null)
      hint = HINTS['not-found']
      if (parts) parts.card.dataset.outcome = 'not-found'
      fill(ensureParts(), current.step)
    }
    if (!anchor) {
      place(null)
      return
    }
    const box = boxOf(anchor)
    overlay.highlight(box)
    place(box)
  }

  function schedule() {
    frame ??= window.requestAnimationFrame(draw)
  }

  function track(on: boolean) {
    const method = on ? 'addEventListener' : 'removeEventListener'
    window[method]('scroll', schedule, { capture: true, passive: true })
    window[method]('resize', schedule, { capture: true, passive: true })
  }

  /** Removes everything this player drew; the worker is told by the caller, if at all. */
  function teardown() {
    const shown = current
    renderToken += 1
    current = undefined
    anchor = undefined
    hint = undefined
    busy = false
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    frame = undefined
    track(false)
    overlay.highlight(null)
    overlay.hidePlayerCard()
    if (shown) remember(shown.step.runId)
  }

  /** Marks a run as ended for good on this page (bounded). */
  function remember(runId: string) {
    ended.delete(runId)
    ended.add(runId)
    for (const oldest of ended) {
      if (ended.size <= MAX_ENDED) break
      ended.delete(oldest)
    }
  }

  function end(reason: 'finished' | 'closed') {
    const shown = current
    if (!shown) return
    teardown()
    void deps.send({ type: 'player.end', runId: shown.step.runId, reason })
  }

  const canGo = (step: PlayerStep, direction: Direction) =>
    direction === 'next' ? step.index < step.count - 1 : step.index > 0

  async function go(direction: Direction) {
    const shown = current
    if (!shown || busy || !canGo(shown.step, direction)) return
    lastDirection = direction
    setBusy(true)
    const answer = readStepAnswer(
      await deps.send({
        type: 'player.go',
        runId: shown.step.runId,
        generation: shown.step.generation,
        direction,
      }),
    )
    // Closed, replaced or hidden meanwhile: the answer is about nothing shown.
    if (current !== shown) return
    setBusy(false)
    if ('step' in answer) {
      if (
        answer.step.runId === shown.step.runId &&
        answer.step.generation > shown.step.generation
      ) {
        current = { step: answer.step }
        void render(current, false)
      }
      return
    }
    if (answer.error === 'STALE') {
      teardown()
      overlay.showToast(STALE_TEXT)
      return
    }
    if (answer.error !== 'BAD_REQUEST') setHint(HINTS.unreachable)
  }

  function resolve(step: PlayerStep): Resolution {
    try {
      return resolveTarget(step.target, stepPagePattern(step.urlPattern, step.target), {
        document,
        href: window.location.href,
        isRendered: rendered,
      })
    } catch {
      // A malformed descriptor fails closed: never a guess.
      return {
        outcome: 'unsupported',
        reason: 'invalid-target',
        diagnostics: { strategies: {}, rendered: 0, vetoed: 0, blocked: 0, top: [] },
      }
    }
  }

  /**
   * The element once its box held still across two animation frames;
   * undefined if it went away or never held still within the checks (never a
   * substitute: the caller shows the step unanchored).
   */
  async function settle(element: Element, token: number): Promise<Element | undefined> {
    for (let check = 0; check < STABILITY_CHECKS; check += 1) {
      const before = boxOf(element)
      await nextFrame()
      await nextFrame()
      if (token !== renderToken) return undefined
      if (!element.isConnected || !rendered(element)) return undefined
      if (sameBox(before, boxOf(element))) return element
    }
    return undefined
  }

  /** Something other than the target (or our UI) is on top of its centre: a warning only. */
  function occluded(element: Element): boolean {
    const box = boxOf(element)
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return hit !== null && hit !== element && !element.contains(hit) && !overlay.isOwn(hit)
  }

  /** Takes the focus for the card only when the page has none (never from a field). */
  function focusIfIdle(target: Parts) {
    const active = document.activeElement
    if (active === null || active === document.body || active === document.documentElement) {
      target.title.focus({ preventScroll: true })
    }
  }

  async function render(shown: { step: PlayerStep }, first: boolean) {
    const token = ++renderToken
    const { step } = shown
    anchor = undefined
    hint = undefined
    overlay.highlight(null)
    fill(ensureParts(), step)

    let resolution = resolve(step)
    let element = resolution.outcome === 'resolved' ? resolution.element : undefined
    if (element) {
      element = await settle(element, token)
      if (token !== renderToken) return
      if (!element) resolution = { ...resolution, outcome: 'not-found', reason: 'unstable' }
    }
    const target = ensureParts()
    let skip = false
    target.card.dataset.outcome = resolution.outcome
    target.card.dataset.step = String(step.index)
    delete target.card.dataset.occluded

    if (element) {
      if (!inView(boxOf(element), viewport())) {
        element.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: reducedMotion() ? 'instant' : 'smooth',
        })
      }
      if (occluded(element)) target.card.dataset.occluded = 'true'
      anchor = element
    } else if (resolution.outcome !== 'none' && resolution.outcome !== 'resolved') {
      const policy =
        resolution.outcome === 'ambiguous'
          ? step.target?.resolution.onAmbiguous
          : resolution.outcome === 'not-found'
            ? step.target?.resolution.onNotFound
            : 'show-unanchored'
      if (policy === 'end') {
        end('closed')
        overlay.showToast(ENDED_TEXT)
        return
      }
      hint = HINTS[resolution.outcome]
      fill(target, step)
      skip = policy === 'skip' && canGo(step, lastDirection)
    }
    track(true)
    draw()
    if (first) focusIfIdle(target)
    // Announced a frame after the card is shown, so a newly shown region is heard.
    void nextFrame().then(() => {
      if (token === renderToken) {
        target.live.textContent = `Step ${String(step.index + 1)} of ${String(step.count)}: ${step.title}`
      }
    })
    // The descriptor asked to skip a step that cannot be shown, the way the user was going.
    if (skip) void go(lastDirection)
  }

  return {
    show(step) {
      if (ended.has(step.runId)) return false
      if (current && current.step.runId !== step.runId) teardown()
      // The same run: an older or repeated step changes nothing.
      if (current && current.step.generation >= step.generation) return true
      const first = current === undefined
      current = { step }
      busy = false
      void render(current, first)
      return true
    },
    hide(runId) {
      // Fail closed: a hide that arrives before its show still ends the run here.
      if (current?.step.runId === runId) teardown()
      else remember(runId)
    },
    stop() {
      teardown()
    },
    get runId() {
      return current?.step.runId
    },
  }
}
