import { matchPage } from '../../lib/url-pattern'
import type { PlayerStep } from '../../messaging/protocol'
import { readStepAnswer } from '../messages'
import type { Overlay } from '../overlay'
import {
  isRendered,
  isUsable,
  resolveTarget,
  stepPagePattern,
  topModal,
  type Resolution,
} from '../resolve/resolver'
import { inView, placeCard, type Box } from './position'

/**
 * The Guide Player on the page (Phases 6a and 6b): one step of one run at a
 * time, in the isolated overlay (ADR 0013). The worker decides which step is shown;
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
 * The keyboard shortcut (`focus-guide`, Phase 6b) moves the focus to the card
 * on purpose and remembers where it was; Close, Escape and Finish give it back
 * to that element if it is still there, and only when the card took the focus.
 *
 * Dynamic pages (Phase 6b, ADR 0014): a target that is not there yet, or not
 * yet the only match, is waited for. While a step is shown, one
 * `MutationObserver` watches the document's light DOM; at most one attempt
 * runs per `CHECK_INTERVAL_MS`, until the descriptor's `timeoutMs`, and every
 * observer and timer of a step is released with its `AbortController` when
 * the step changes or the guide ends, is hidden or stops.
 *
 * A target that leaves while anchored (removed, hidden, re-rendered by a
 * framework, or shut out by a modal dialog) loses its highlight at once and
 * is resolved again, from the descriptor, for `GRACE_MS` at most. A safe match
 * that holds still is anchored again; otherwise the step stays on its own
 * with a hint. Losing a target the user was shown never skips or ends the
 * guide: the user may just have used it.
 *
 * Modal dialogs (ADR 0019): while one is open, the overlay lives inside it, so
 * the card is on top and can take the focus; it moves back when the dialog
 * closes. Targets behind the dialog are never accepted (ADR 0014).
 *
 * Navigation (ADR 0019): when the URL changes in this document (`urlChanged`),
 * the current step is shown again for the new URL; a step whose page pattern
 * does not match waits there for the user to navigate (`off-page`), never
 * skipped or ended. The run, its step and its generation do not change.
 */

export const HINTS = {
  'not-found': "This step's element isn't on the page right now.",
  ambiguous: 'More than one element matches this step, so none is highlighted.',
  'wrong-page': 'This step is on another page. Navigate there to continue.',
  unsupported: "ContextLayer can't point at this step's element on this page yet.",
  waiting: "Looking for this step's element…",
  unreachable: "ContextLayer couldn't be reached. Try again.",
} as const

/** At most one resolution attempt per this many milliseconds while waiting (ADR 0014: ~150 ms). */
export const CHECK_INTERVAL_MS = 150

/**
 * How long a target that left mid-step is looked for again (ADR 0014: 1 to 2
 * seconds), at most the descriptor's `timeoutMs`: long enough for a
 * framework to put an equivalent element back, short enough not to leave a
 * step looking for something the user removed.
 */
export const GRACE_MS = 1_500

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
  /** The open modal dialog, if any (default `topModal`); given in tests (jsdom has none). */
  modal?: (document: Document) => Element | null
}

export interface Player {
  /** Shows this step of its run (replacing another run). False for a run ended here. */
  show(step: PlayerStep): boolean
  /** Removes the run's UI, if that run is the one shown (the worker ended it). */
  hide(runId: string): void
  /** Removes the UI without telling the worker (the script stops, Edit Mode starts). */
  stop(): void
  /** The URL changed in this document: the current step is shown again for it. */
  urlChanged(): void
  /** The keyboard shortcut: moves the focus to the card; false when nothing is shown. */
  focus(): boolean
  /**
   * The document goes into bfcache: the UI and every wait go, but the run is
   * not marked as ended here, since the worker gives it back when the
   * document returns (ADR 0019).
   */
  suspend(): void
  readonly runId: string | undefined
}

/**
 * What the card is doing for the step shown, on `data-state`:
 * - `resolving`: the first look at the page;
 * - `waiting`: the target is not there yet, or not yet the only match;
 * - `anchored`: next to its target;
 * - `regaining`: its target left; looked for again for a short grace period;
 * - `off-page`: the step is on another page; waiting for the user to go there;
 * - `shown`: on its own, for good (no target, or after the wait).
 */
type Phase = 'resolving' | 'waiting' | 'anchored' | 'regaining' | 'off-page' | 'shown'

/** One showing of one step: everything it started stops with its controller. */
interface View {
  token: number
  controller: AbortController
  observer?: MutationObserver
  /** The next throttled attempt, if one is scheduled. */
  pending?: number
  /** The end of the wait. */
  deadline?: number
  /** The latest outcome while waiting, for the descriptor's policy at the deadline. */
  outcome: Resolution['outcome']
  settling: boolean
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
  const modalOf = deps.modal ?? topModal
  /** Still there, visible and reachable (not shut out by an open modal dialog). */
  const usable = (element: Element) => isUsable(element, modalOf(document), rendered)

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
  let phase: Phase = 'resolving'
  let view: View | undefined
  /** The card took the focus (at start, or by the shortcut), and from where. */
  let tookFocus = false
  let returnFocus: Element | undefined
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
    syncHost()
    if (anchor && !usable(anchor) && view) {
      loseAnchor(view)
      return
    }
    if (!anchor) {
      // While a lost target is looked for again, the card stays where it was.
      if (phase === 'regaining') overlay.showPlayerCard()
      else place(null)
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

  /**
   * Removes everything this player drew; the worker is told by the caller, if
   * at all. The run is marked as ended on this page unless `remember` is false.
   */
  function teardown(remember = true) {
    const shown = current
    renderToken += 1
    stopView()
    current = undefined
    anchor = undefined
    hint = undefined
    busy = false
    tookFocus = false
    returnFocus = undefined
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    frame = undefined
    track(false)
    overlay.highlight(null)
    overlay.hidePlayerCard()
    overlay.setContainer(null)
    if (shown && remember) markEnded(shown.step.runId)
  }

  /** Marks a run as ended for good on this page (bounded). */
  function markEnded(runId: string) {
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
    // Given back only if the card took the focus and still has it.
    const active = document.activeElement
    const restore = tookFocus && active !== null && overlay.isOwn(active) ? returnFocus : undefined
    teardown()
    // Only an element that can take the focus, and only if it is still on the page.
    if (restore?.isConnected && 'focus' in restore) {
      ;(restore as HTMLElement).focus({ preventScroll: true })
    }
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

  /** Stops the step being shown: its observer, its timers and any attempt in flight. */
  function stopView() {
    view?.controller.abort()
    view = undefined
  }

  function newView(): View {
    stopView()
    const controller = new AbortController()
    const next: View = {
      token: ++renderToken,
      controller,
      outcome: 'not-found',
      settling: false,
    }
    controller.signal.addEventListener('abort', () => {
      next.observer?.disconnect()
      if (next.pending !== undefined) window.clearTimeout(next.pending)
      if (next.deadline !== undefined) window.clearTimeout(next.deadline)
    })
    view = next
    return next
  }

  const live = (shown: View) => shown === view && !shown.controller.signal.aborted

  /**
   * Watches the document's light DOM for this step: one observer, and at most
   * one `tick` per `CHECK_INTERVAL_MS` however many mutations come in.
   */
  function observe(shown: View) {
    if (shown.observer || !live(shown)) return
    const { MutationObserver } = window as Window & typeof globalThis
    const observer = new MutationObserver(() => {
      if (shown.pending !== undefined) return
      shown.pending = window.setTimeout(() => {
        shown.pending = undefined
        if (live(shown)) tick(shown)
      }, CHECK_INTERVAL_MS)
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    shown.observer = observer
  }

  /** Puts the overlay inside the open modal dialog, or back; true when it moved. */
  function syncHost(): boolean {
    return overlay.setContainer(modalOf(document))
  }

  function tick(shown: View) {
    // A modal dialog opened or closed: the card goes with it and is drawn again.
    if (syncHost()) schedule()
    if (phase === 'waiting' || phase === 'regaining') void attempt(shown)
    else if (phase === 'anchored') {
      // The target may have left, or moved: check it and draw again.
      if (anchor && !usable(anchor)) loseAnchor(shown)
      else schedule()
    }
  }

  /**
   * The anchored target left: no highlight on where it was, and a short
   * search from the descriptor for the element that replaced it.
   */
  function loseAnchor(shown: View) {
    if (!live(shown) || phase !== 'anchored') return
    anchor = undefined
    overlay.highlight(null)
    phase = 'regaining'
    hint = HINTS.waiting
    shown.outcome = 'not-found'
    const target = ensureParts()
    target.card.dataset.state = phase
    target.card.dataset.outcome = 'not-found'
    if (current) fill(target, current.step)
    const limit = current?.step.target?.resolution.timeoutMs ?? 0
    shown.deadline = window.setTimeout(
      () => {
        giveUp(shown)
      },
      Math.min(GRACE_MS, limit),
    )
    void attempt(shown)
  }

  /** One more look for the target while waiting; anchors it once it is safely there. */
  async function attempt(shown: View) {
    const step = current?.step
    if (!step || shown.settling) return
    const resolution = resolve(step)
    if (resolution.outcome !== 'resolved' || !resolution.element) {
      if (resolution.outcome === 'not-found' || resolution.outcome === 'ambiguous') {
        shown.outcome = resolution.outcome
        if (parts) parts.card.dataset.outcome = resolution.outcome
      }
      return
    }
    shown.settling = true
    const element = await settle(resolution.element, shown.token)
    shown.settling = false
    if (!live(shown) || !element) return
    anchorTo(shown, element)
  }

  /** The target is there and held still: highlight it and place the card next to it. */
  function anchorTo(shown: View, element: Element) {
    if (shown.deadline !== undefined) window.clearTimeout(shown.deadline)
    shown.deadline = undefined
    phase = 'anchored'
    hint = undefined
    const target = ensureParts()
    target.card.dataset.state = phase
    target.card.dataset.outcome = 'resolved'
    delete target.card.dataset.occluded
    if (current) fill(target, current.step)
    if (!inView(boxOf(element), viewport())) {
      element.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: reducedMotion() ? 'instant' : 'smooth',
      })
    }
    if (occluded(element)) target.card.dataset.occluded = 'true'
    anchor = element
    // Watched while anchored too: a target that leaves is looked for again.
    observe(shown)
    draw()
  }

  /**
   * The wait is over without a safe target: the descriptor's policy for the
   * last outcome (on its own with a hint, skip the way the user was going, or
   * end the guide).
   */
  function giveUp(shown: View) {
    shown.deadline = undefined
    const step = current?.step
    if (!step || !live(shown)) return
    if (phase === 'regaining') {
      showOnItsOwn(shown, 'not-found', HINTS['not-found'])
      return
    }
    if (phase !== 'waiting') return
    const outcome = shown.outcome === 'ambiguous' ? 'ambiguous' : 'not-found'
    const policy =
      outcome === 'ambiguous'
        ? step.target?.resolution.onAmbiguous
        : step.target?.resolution.onNotFound
    if (policy === 'end') {
      end('closed')
      overlay.showToast(ENDED_TEXT)
      return
    }
    showOnItsOwn(shown, outcome, HINTS[outcome])
    if (policy === 'skip' && canGo(step, lastDirection)) void go(lastDirection)
  }

  /** The card on its own, for good, with a hint (or none for a step without a target). */
  function showOnItsOwn(shown: View, outcome: Resolution['outcome'], text: string | undefined) {
    if (!live(shown)) return
    phase = 'shown'
    hint = text
    const target = ensureParts()
    target.card.dataset.state = phase
    target.card.dataset.outcome = outcome
    if (current) fill(target, current.step)
    // Still watched, though nothing is looked for: a modal dialog may open.
    observe(shown)
    draw()
  }

  function resolve(step: PlayerStep): Resolution {
    try {
      return resolveTarget(step.target, stepPagePattern(step.urlPattern, step.target), {
        document,
        href: window.location.href,
        isRendered: rendered,
        modal: modalOf(document),
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

  /** The card's title takes the focus; `from` is where to give it back later. */
  function takeFocus(target: Parts, from: Element | null) {
    returnFocus = from ?? undefined
    target.title.focus({ preventScroll: true })
    tookFocus = true
  }

  const idle = (active: Element | null) =>
    active === null || active === document.body || active === document.documentElement

  /** Takes the focus for the card only when the page has none (never from a field). */
  function focusIfIdle(target: Parts) {
    if (idle(document.activeElement)) takeFocus(target, null)
  }

  async function render(showing: { step: PlayerStep }, first: boolean) {
    const shown = newView()
    const { step } = showing
    anchor = undefined
    hint = undefined
    phase = 'resolving'
    overlay.highlight(null)
    const target = ensureParts()
    fill(target, step)
    target.card.dataset.step = String(step.index)
    target.card.dataset.state = phase
    delete target.card.dataset.occluded

    const resolution = resolve(step)
    shown.outcome = resolution.outcome
    target.card.dataset.outcome = resolution.outcome
    let element = resolution.outcome === 'resolved' ? resolution.element : undefined
    if (element) {
      element = await settle(element, shown.token)
      if (!live(shown)) return
    }
    track(true)
    if (element) {
      anchorTo(shown, element)
    } else if (resolution.outcome === 'none') {
      showOnItsOwn(shown, 'none', undefined)
    } else if (resolution.outcome === 'unsupported') {
      showOnItsOwn(shown, 'unsupported', HINTS.unsupported)
    } else if (resolution.outcome === 'wrong-page') {
      // Waits for the user to navigate there (`urlChanged`); never skipped or ended.
      showOnItsOwn(shown, 'wrong-page', HINTS['wrong-page'])
      phase = 'off-page'
      target.card.dataset.state = phase
    } else {
      // Not there yet, not yet the only match, or not holding still: wait,
      // within the descriptor's limit, then apply its policy.
      if (resolution.outcome === 'resolved') shown.outcome = 'not-found'
      phase = 'waiting'
      hint = HINTS.waiting
      target.card.dataset.state = phase
      target.card.dataset.outcome = shown.outcome
      fill(target, step)
      draw()
      observe(shown)
      shown.deadline = window.setTimeout(() => {
        giveUp(shown)
      }, step.target?.resolution.timeoutMs ?? 0)
    }
    if (!live(shown)) return
    if (first) focusIfIdle(target)
    // Announced a frame after the card is shown, so a newly shown region is heard.
    void nextFrame().then(() => {
      if (live(shown)) {
        target.live.textContent = `Step ${String(step.index + 1)} of ${String(step.count)}: ${step.title}`
      }
    })
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
      else markEnded(runId)
    },
    stop() {
      teardown()
    },
    suspend() {
      teardown(false)
    },
    focus() {
      if (!current) return false
      const active = document.activeElement
      const target = ensureParts()
      overlay.showPlayerCard()
      // Already in the card: nothing to remember.
      if (active !== null && overlay.isOwn(active)) target.title.focus({ preventScroll: true })
      else takeFocus(target, idle(active) ? null : active)
      return true
    },
    urlChanged() {
      const showing = current
      if (!showing) return
      const { step } = showing
      // Still anchored to a target that still belongs here: nothing to redo.
      if (
        phase === 'anchored' &&
        anchor &&
        usable(anchor) &&
        matchPage(stepPagePattern(step.urlPattern, step.target), window.location.href) === 'match'
      ) {
        schedule()
        return
      }
      void render(showing, false)
    },
    get runId() {
      return current?.step.runId
    },
  }
}
