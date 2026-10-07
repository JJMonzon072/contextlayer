import type { TargetDescriptor, TargetLocator, UrlPattern } from '@contextlayer/shared'

import { matchPage } from '../../lib/url-pattern'
import { labelText, roleOf } from '../capture/accessible'
import { describeElement, promote } from '../capture/descriptor'
import { findByLabel, findByRoleName, findBySelector, findByText } from '../capture/locate'
import { attributeSelector } from '../capture/selectors'
import { capturedText } from '../capture/text'

/**
 * Static target resolution for the player (ADR 0014, "Resolution"; Phase 6a):
 * the top document's light DOM as it is now, no waiting, no observers.
 *
 * 1. The step's page pattern must match the page (`wrong-page`).
 * 2. Frame and shadow paths are Phase 6c (`unsupported`), never guessed.
 * 3. Candidates come from the stored locators, strongest first, by the same
 *    definitions capture counted them with (`capture/locate.ts`); at most
 *    `MAX_CANDIDATES`, never a scan of the whole page.
 * 4. Disconnected, inert, invisible and empty candidates are dropped. While a
 *    modal dialog is open, candidates outside it (inert, though they still
 *    pass `checkVisibility()`) are scored but never accepted: if the best one
 *    is behind the modal the outcome is `not-found` (`behind-modal`), and
 *    they never compete with one inside it.
 * 5. Each candidate is described by the functions capture used
 *    (`describeElement`) and scored `Σ wᵢ·simᵢ / Σ wᵢ` over the signals the
 *    stored descriptor has; a different value for the same test attribute,
 *    or a different role, vetoes it, and so does a candidate outside any modal
 *    dialog for a target picked inside one.
 * 6. A unique test-id match resolves at once. Otherwise the best candidate
 *    must match the element by identity (`MIN_IDENTITY`), or, for a target
 *    with nothing but its position, sit exactly where it was; reach
 *    `minScore`; and lead the runner-up by `minMargin`. Candidates identity
 *    cannot tell apart are `ambiguous` unless their context (a named region,
 *    a heading) does: structure never breaks the tie.
 *
 * Nothing here reads what users typed (the capture functions exclude it), and
 * the diagnostics carry scores and strategy names, never page text.
 */

export type ResolutionOutcome =
  | 'resolved'
  | 'ambiguous'
  | 'not-found'
  | 'wrong-page'
  | 'unsupported'
  /** The step has no target: shown without pointing at anything, on purpose. */
  | 'none'

export interface ResolutionDiagnostics {
  /** Candidates per strategy that produced them, before filtering. */
  strategies: Partial<Record<TargetLocator['strategy'], number>>
  /** Candidates left after the visibility filter. */
  rendered: number
  vetoed: number
  /** Rendered candidates shut out by an open modal dialog. */
  blocked: number
  /** The best scores, rounded, with the strategies that found each candidate. */
  top: { score: number; strategies: TargetLocator['strategy'][] }[]
}

export interface Resolution {
  outcome: ResolutionOutcome
  /** Only when `resolved`. */
  element?: Element
  /** Why, as a short machine-readable code (for tests and debugging). */
  reason: string
  diagnostics: ResolutionDiagnostics
}

export interface ResolveOptions {
  document: Document
  href: string
  /** Visible and rendered; replaced in tests (jsdom has no layout). */
  isRendered?: (element: Element) => boolean
  /**
   * The open modal dialog, if any (default: `topModal`). Elements outside it
   * are inert although they still pass `checkVisibility()` (ADR 0019), so
   * they are left out. Given in tests: jsdom has no modal dialogs.
   */
  modal?: Element | null
}

/** At most this many candidates are scored (ADR 0014: "about 50 per root"). */
export const MAX_CANDIDATES = 50

/**
 * Starting weights from ADR 0014. They are relative: a score is a weighted
 * mean over the signals a descriptor has, so a missing signal never counts
 * against a candidate.
 */
export const WEIGHTS = {
  testId: 1,
  id: 0.8,
  roleName: 0.8,
  label: 0.7,
  text: 0.6,
  attributes: 0.5,
  anchors: 0.5,
  container: 0.4,
  cssPath: 0.3,
  classes: 0.25,
  xpath: 0.2,
  position: 0.1,
} as const

type Signal = keyof typeof WEIGHTS

/**
 * How closely a candidate must match on what says which element it is (test
 * attribute, id, name, label, text, a describing attribute; weighted like the
 * score) to count as that element. "Delete invoice" for a stored "Approve
 * invoice" is 0.5; "Save the customer" for "Save customer" is 0.8. A starting
 * value, like the thresholds, not a calibrated one.
 */
export const MIN_IDENTITY = 0.7

/** Attributes that identify an element; `type` is shared by every button. */
const IDENTIFYING_ATTRIBUTES = ['name', 'title', 'placeholder', 'alt', 'aria-label']

/** Rendered and visible: not disconnected, not inert, not hidden, not empty. */
export function isRendered(element: Element): boolean {
  if (!element.isConnected || element.closest('[inert]')) return false
  if (
    typeof element.checkVisibility === 'function' &&
    !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  ) {
    return false
  }
  const box = element.getBoundingClientRect()
  return box.width > 0 && box.height > 0
}

/** The open modal `<dialog>` on top, if any; null where `:modal` is not supported. */
export function topModal(document: Document): Element | null {
  try {
    const open = document.querySelectorAll('dialog:modal')
    return open.item(open.length - 1)
  } catch {
    return null
  }
}

/** Rendered and reachable: not hidden, and not shut out by an open modal dialog. */
export function isUsable(
  element: Element,
  modal: Element | null,
  rendered: (element: Element) => boolean = isRendered,
): boolean {
  return rendered(element) && (modal === null || modal.contains(element))
}

const behind = (element: Element, modal: Element | null) =>
  modal !== null && !modal.contains(element)

/** The page pattern a step is checked against: the step's own, else its target's. */
export function stepPagePattern(
  stepPattern: UrlPattern | null,
  target: TargetDescriptor | null,
): UrlPattern | null {
  return stepPattern ?? target?.page.urlPattern ?? null
}

/** Captured text compared the way it was captured (normalized, redacted, capped). */
function sameText(stored: string | undefined, raw: string | null | undefined): number {
  if (stored === undefined) return 0
  const now = capturedText(raw)?.text
  if (now === stored) return 1
  if (now === undefined) return 0
  // A close variant (a word added or changed) counts partly: token overlap (Dice).
  const words = (value: string) => new Set(value.toLowerCase().split(' '))
  const a = words(stored)
  const b = words(now)
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

function locatorElements(document: Document, locator: TargetLocator): Element[] | undefined {
  switch (locator.strategy) {
    case 'testId':
      return findBySelector(document, attributeSelector(locator.attr, locator.value))
    case 'id':
      return findBySelector(document, attributeSelector('id', locator.value))
    case 'role':
      return findByRoleName(document, locator.role, locator.name)
    case 'label':
      return findByLabel(document, locator.text)
    case 'placeholder':
      return findBySelector(document, attributeSelector('placeholder', locator.text))
    case 'altText':
      return findBySelector(document, attributeSelector('alt', locator.text))
    case 'title':
      return findBySelector(document, attributeSelector('title', locator.text))
    // The deepest elements with the text, promoted like capture promoted the pick.
    case 'text':
      return findByText(document, locator.text)?.map((element) => promote(element).element)
    case 'css':
    case 'cssPath':
      return findBySelector(document, locator.selector)
    case 'xpath':
      return xpathElements(document, locator.expression)
  }
}

function xpathElements(document: Document, expression: string): Element[] | undefined {
  try {
    const found = document.evaluate(
      expression,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    )
    const elements: Element[] = []
    for (let index = 0; index < found.snapshotLength && index < MAX_CANDIDATES; index += 1) {
      const node = found.snapshotItem(index)
      if (node instanceof Element) elements.push(node)
    }
    return elements
  } catch {
    return undefined
  }
}

function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

/**
 * Per-signal similarity in [0, 1] of a candidate to the stored descriptor,
 * for the signals the descriptor has; `identity`, the weighted match on what
 * says which element it is (roles and position aside); `veto` when the
 * candidate contradicts it.
 */
function signalsOf(
  target: TargetDescriptor,
  element: Element,
): { signals: Partial<Record<Signal, number>>; identity?: number; veto?: string } {
  const stored = target.element
  const now = describeElement(element)
  const signals: Partial<Record<Signal, number>> = {}
  const identity: [weight: number, similarity: number][] = []

  if (stored.testIds.length > 0) {
    let same = 0
    for (const { attr, value } of stored.testIds) {
      const current = element.getAttribute(attr)
      if (current === value) same += 1
      else if (current !== null) return { signals, veto: 'test-id' }
    }
    signals.testId = same / stored.testIds.length
    identity.push([WEIGHTS.testId, signals.testId])
  }
  // A generated id never becomes trusted, here either.
  if (stored.id && !stored.id.generated) {
    signals.id = element.getAttribute('id') === stored.id.value ? 1 : 0
    identity.push([WEIGHTS.id, signals.id])
  }
  const role = roleOf(element)
  if (stored.role !== undefined && role !== undefined && role !== stored.role) {
    return { signals, veto: 'role' }
  }
  if (stored.role !== undefined || stored.accessibleName !== undefined) {
    const parts: number[] = []
    if (stored.role !== undefined) parts.push(role === stored.role ? 1 : 0)
    if (stored.accessibleName !== undefined) {
      const name =
        now.element.accessibleName === stored.accessibleName
          ? 1
          : sameText(stored.accessibleName, now.element.accessibleName)
      parts.push(name)
      identity.push([WEIGHTS.roleName, name])
    }
    signals.roleName = parts.reduce((sum, part) => sum + part, 0) / parts.length
  }
  const storedLabel = target.anchors.find((anchor) => anchor.relation === 'label')
  if (storedLabel?.relation === 'label') {
    signals.label = sameText(storedLabel.text, labelText(element))
    identity.push([WEIGHTS.label, signals.label])
  }
  if (stored.text !== undefined) {
    signals.text = now.element.text === stored.text ? 1 : sameText(stored.text, now.element.text)
    identity.push([WEIGHTS.text, signals.text])
  }

  const attributes = Object.entries(stored.attributes)
  let sameAttributes = element.localName === stored.tag ? 1 : 0
  for (const [name, value] of attributes) {
    if ((now.element.attributes[name] ?? undefined) === (value ?? undefined)) sameAttributes += 1
  }
  signals.attributes = sameAttributes / (attributes.length + 1)
  const identifyingAttributes = attributes.filter(
    ([name, value]) => value !== null && IDENTIFYING_ATTRIBUTES.includes(name),
  )
  if (identifyingAttributes.length > 0) {
    const same = identifyingAttributes.filter(
      ([name, value]) => now.element.attributes[name] === value,
    ).length
    identity.push([WEIGHTS.attributes, same / identifyingAttributes.length])
  }

  if (target.anchors.length > 0) {
    const found = target.anchors.filter((anchor) =>
      now.anchors.some((candidate) => {
        if (candidate.relation !== anchor.relation) return false
        if (anchor.relation === 'ancestor' && candidate.relation === 'ancestor') {
          return (
            candidate.tag === anchor.tag &&
            candidate.id === anchor.id &&
            candidate.testId?.value === anchor.testId?.value
          )
        }
        if (anchor.relation === 'precedingHeading' && candidate.relation === 'precedingHeading') {
          return candidate.text === anchor.text && candidate.level === anchor.level
        }
        return anchor.relation === 'label' && candidate.relation === 'label'
          ? candidate.text === anchor.text
          : false
      }),
    )
    signals.anchors = found.length / target.anchors.length
  }
  if (target.container) {
    const container = now.container
    // A target picked inside a modal dialog is only ever that dialog's: a copy
    // outside one (an inline panel, a page form) is another element.
    if (target.container.modal === true && container?.modal !== true) {
      return { signals, veto: 'modal' }
    }
    signals.container =
      container?.kind !== target.container.kind
        ? 0
        : container.accessibleName === target.container.accessibleName
          ? 1
          : 0.5
  }

  const cssPath = target.locators.find((locator) => locator.strategy === 'cssPath')
  if (cssPath?.strategy === 'cssPath') signals.cssPath = matches(element, cssPath.selector) ? 1 : 0
  const storedClasses = stored.classes?.stable ?? []
  const css = target.locators.find((locator) => locator.strategy === 'css')
  if (storedClasses.length > 0 || css) {
    const nowClasses = new Set(now.element.classes?.stable ?? [])
    const shared = storedClasses.filter((name) => nowClasses.has(name)).length
    const union = new Set([...storedClasses, ...nowClasses]).size
    const jaccard = union === 0 ? 1 : shared / union
    signals.classes =
      css?.strategy === 'css' ? (jaccard + (matches(element, css.selector) ? 1 : 0)) / 2 : jaccard
  }
  const xpath = target.locators.find((locator) => locator.strategy === 'xpath')
  if (xpath?.strategy === 'xpath') {
    signals.xpath = xpathElements(element.ownerDocument, xpath.expression)?.includes(element)
      ? 1
      : 0
  }
  if (stored.nthOfType) {
    const nth = now.element.nthOfType
    signals.position =
      nth?.index === stored.nthOfType.index ? (nth.count === stored.nthOfType.count ? 1 : 0.5) : 0
  }
  const weight = identity.reduce((sum, [part]) => sum + part, 0)
  return {
    signals,
    ...(weight > 0 && {
      identity: identity.reduce((sum, [part, similarity]) => sum + part * similarity, 0) / weight,
    }),
  }
}

function score(
  signals: Partial<Record<Signal, number>>,
  only?: readonly Signal[],
): number | undefined {
  let weighted = 0
  let total = 0
  for (const [signal, similarity] of Object.entries(signals) as [Signal, number][]) {
    if (only && !only.includes(signal)) continue
    weighted += WEIGHTS[signal] * similarity
    total += WEIGHTS[signal]
  }
  return total === 0 ? undefined : weighted / total
}

/** Where an element is by meaning (a named region, an anchor), not by position. */
const CONTEXT: readonly Signal[] = ['anchors', 'container']

const empty = (): ResolutionDiagnostics => ({
  strategies: {},
  rendered: 0,
  vetoed: 0,
  blocked: 0,
  top: [],
})

/**
 * Where a step's target is on this page now, or why it cannot be shown
 * safely. Never returns an element unless the outcome is `resolved`.
 */
export function resolveTarget(
  target: TargetDescriptor | null,
  pagePattern: UrlPattern | null,
  options: ResolveOptions,
): Resolution {
  const page = matchPage(pagePattern, options.href)
  if (page === 'invalid') {
    return { outcome: 'unsupported', reason: 'invalid-page-pattern', diagnostics: empty() }
  }
  if (page === 'no-match') return { outcome: 'wrong-page', reason: 'page', diagnostics: empty() }
  if (!target) return { outcome: 'none', reason: 'no-target', diagnostics: empty() }
  if (target.framePath.length > 0) {
    return { outcome: 'unsupported', reason: 'frame-path', diagnostics: empty() }
  }
  if (target.shadowPath.length > 0) {
    return { outcome: 'unsupported', reason: 'shadow-path', diagnostics: empty() }
  }

  const { document } = options
  const modal = options.modal === undefined ? topModal(document) : options.modal
  const rendered = options.isRendered ?? isRendered
  const diagnostics = empty()
  const found = new Map<Element, TargetLocator['strategy'][]>()
  let uniqueTestId: Element | undefined
  for (const locator of target.locators) {
    const elements = locatorElements(document, locator) ?? []
    diagnostics.strategies[locator.strategy] =
      (diagnostics.strategies[locator.strategy] ?? 0) + elements.length
    if (locator.strategy === 'testId' && locator.matchCount === 1) {
      const visible = elements.filter((element) => isUsable(element, modal, rendered))
      if (visible.length === 1 && elements.length === 1) uniqueTestId ??= visible[0]
    }
    for (const element of elements) {
      if (found.size >= MAX_CANDIDATES && !found.has(element)) break
      found.set(element, [...(found.get(element) ?? []), locator.strategy])
    }
  }

  const scored: {
    element: Element
    score: number
    identity: number | undefined
    signals: Partial<Record<Signal, number>>
    strategies: TargetLocator['strategy'][]
    /** Shut out by an open modal dialog: never accepted, never a runner-up. */
    blocked: boolean
  }[] = []
  for (const [element, strategies] of found) {
    if (!rendered(element)) continue
    diagnostics.rendered += 1
    const { signals, identity, veto } = signalsOf(target, element)
    if (veto) {
      diagnostics.vetoed += 1
      continue
    }
    const blocked = behind(element, modal)
    if (blocked) diagnostics.blocked += 1
    scored.push({ element, score: score(signals) ?? 0, identity, signals, strategies, blocked })
  }
  // On equal scores the reachable candidate comes first.
  scored.sort((a, b) => b.score - a.score || Number(a.blocked) - Number(b.blocked))
  diagnostics.top = scored
    .slice(0, 3)
    .map(({ score: value, strategies }) => ({ score: Math.round(value * 1000) / 1000, strategies }))

  // A unique, stable test attribute names the element: resolved, unless it
  // was vetoed (another role) or dropped as invisible.
  if (uniqueTestId && scored.some((candidate) => candidate.element === uniqueTestId)) {
    return { outcome: 'resolved', element: uniqueTestId, reason: 'test-id', diagnostics }
  }
  const [best] = scored
  if (!best) {
    return {
      outcome: 'not-found',
      reason: found.size === 0 ? 'no-candidates' : 'none-rendered',
      diagnostics,
    }
  }
  // The element the step means is behind an open modal: wait, never take a
  // copy inside the modal instead.
  if (best.blocked) return { outcome: 'not-found', reason: 'behind-modal', diagnostics }
  const runnerUp = scored.slice(1).find((candidate) => !candidate.blocked)

  if (best.identity !== undefined) {
    // Found only by where it sits, or under another name: not the element picked.
    if (best.identity < MIN_IDENTITY) {
      return { outcome: 'not-found', reason: 'no-identity-match', diagnostics }
    }
  } else if (best.signals.cssPath !== 1 || best.signals.position !== 1) {
    // A positional-only target is trusted only where the structure is unchanged.
    return { outcome: 'not-found', reason: 'structure-changed', diagnostics }
  }

  const { minScore, minMargin } = target.resolution
  if (best.score < minScore) return { outcome: 'not-found', reason: 'below-min-score', diagnostics }
  if (runnerUp) {
    // Candidates the identifying signals cannot tell apart are separated only
    // by their context (a named form, a heading), never by structure alone (a
    // path, a position): otherwise ambiguous, whatever the margin.
    if (runnerUp.identity !== undefined && runnerUp.identity >= (best.identity ?? 0)) {
      const context = score(best.signals, CONTEXT)
      const otherContext = score(runnerUp.signals, CONTEXT)
      if (context === undefined || otherContext === undefined || context <= otherContext) {
        return { outcome: 'ambiguous', reason: 'identical-candidates', diagnostics }
      }
    }
    if (best.score - runnerUp.score < minMargin) {
      return { outcome: 'ambiguous', reason: 'margin', diagnostics }
    }
  }
  return { outcome: 'resolved', element: best.element, reason: 'score', diagnostics }
}
