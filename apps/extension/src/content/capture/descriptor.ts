import type { TargetDescriptor, TargetLocator } from '@contextlayer/shared'

import {
  accessibleName,
  contentText,
  isUserAuthored,
  isUserContent,
  labelText,
  roleOf,
} from './accessible'
import { isGeneratedId, isRecordId, isStableClass, isStableTestId } from './identity'
import { pagePattern } from './page'
import {
  attributeSelector,
  countSelector,
  cssEscape,
  cssPath,
  MAX_SELECTOR_LENGTH,
  nthOfType,
} from './selectors'
import { capturedText, exactText } from './text'

/**
 * Capture of a TargetDescriptor v1 (ADR 0014, capture steps 1–7) for an
 * element of the top document's light DOM. Everything is computed when the
 * user selects the element, never while hovering.
 *
 * Each locator's `matchCount` counts, in the whole document, the elements
 * that the locator's own definition selects:
 * - `testId`, `id`, `placeholder`, `altText`, `title`, `css`, `cssPath`:
 *   `querySelectorAll` of the exact attribute or selector;
 * - `role`: elements with that role (`roleOf`) and exactly that accessible
 *   name (`accessibleName`), both from `accessible.ts`;
 * - `label`: form controls whose labels read exactly that text;
 * - `text`: the deepest elements whose visible content (`contentText`) is
 *   exactly that text. For `<button><span>Save</span></button>` that is the
 *   span, and the resolver is expected to promote it like capture does.
 * A value that was redacted or cut never becomes a locator, a locator that
 * cannot be counted is left out (never assumed unique), and XPath is not
 * emitted: in the light DOM it would repeat the CSS path.
 */

/** Test attributes in priority order (first-party first), as in the shared contract. */
const TEST_ATTRIBUTES = [
  'data-contextlayer-id',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
] as const

/** What the user can mean by clicking an icon or a span inside a control. */
const INTERACTIVE =
  'button, a[href], summary, select, textarea, input:not([type="hidden"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="treeitem"]'
/** How far up promotion looks; it never reaches `body`. */
const MAX_PROMOTION_DEPTH = 6
/** Above this many candidates a count is not attempted, so the locator is left out. */
const MAX_CANDIDATES = 5_000
const MAX_HEADINGS = 500
/** Attributes that describe an element without carrying user input. */
const DESCRIBING_ATTRIBUTES = ['type', 'name', 'title', 'placeholder', 'alt', 'aria-label']
const TAG = /^[a-z][a-z0-9-]{0,63}$/
const ROLE = /^[a-z][a-z-]{0,39}$/
const MAX_DESCRIPTOR_LENGTH = 16_384

/** Starting values from ADR 0014, to be calibrated in Phase 6: not measured accuracies. */
const RESOLUTION_DEFAULTS = {
  minScore: 0.65,
  minMargin: 0.15,
  timeoutMs: 10_000,
  textPolicy: 'normalized',
  onAmbiguous: 'show-unanchored',
  onNotFound: 'show-unanchored',
} as const

export type CaptureOutcome =
  { ok: true; element: Element; descriptor: TargetDescriptor } | { ok: false; reason: string }

export interface CaptureContext {
  extensionVersion: string
  capturedAt: Date
  href: string
  viewport?: { width: number; height: number; devicePixelRatio: number }
  chromeMajor?: number
}

/**
 * The control the user meant. Inside an SVG graphic the picked element is
 * the outermost `<svg>` (its paths are not targets); from there, the nearest
 * interactive ancestor within `MAX_PROMOTION_DEPTH` levels, or the picked
 * element itself.
 */
export function promote(hit: Element): {
  picked: Element
  element: Element
  promotion: 'none' | 'interactive-ancestor'
} {
  let picked = hit
  for (let svg = hit.closest('svg'); svg; svg = svg.parentElement?.closest('svg') ?? null) {
    picked = svg
  }
  if (picked.matches(INTERACTIVE)) return { picked, element: picked, promotion: 'none' }
  const document = picked.ownerDocument
  let current = picked.parentElement
  for (let depth = 1; current && depth <= MAX_PROMOTION_DEPTH; depth += 1) {
    if (current === document.body || current === document.documentElement) break
    if (current.matches(INTERACTIVE)) {
      return { picked, element: current, promotion: 'interactive-ancestor' }
    }
    current = current.parentElement
  }
  return { picked, element: picked, promotion: 'none' }
}

/** Why an element cannot be captured in Phase 5, if it cannot. */
export function unsupportedReason(
  element: Element,
  hasClosedShadowRoot: (element: Element) => boolean = () => false,
): string | undefined {
  const document = element.ownerDocument
  if (!element.isConnected) return 'The element is no longer on the page.'
  if (element === document.body || element === document.documentElement) {
    return 'Pick a specific element, not the whole page.'
  }
  if (['iframe', 'frame', 'object', 'embed'].includes(element.localName)) {
    return 'Elements inside frames are not supported yet.'
  }
  if (
    element.getRootNode() !== document ||
    element.shadowRoot !== null ||
    hasClosedShadowRoot(element)
  ) {
    return "Elements inside another component's shadow DOM are not supported yet."
  }
  if (!TAG.test(element.localName)) return 'This kind of element is not supported.'
  return undefined
}

/** The selector that finds every element `roleOf` can give `role`. */
const ROLE_CANDIDATES: Record<string, string> = {
  button: 'button, input, [role]',
  link: 'a[href], area[href], [role]',
  heading: 'h1, h2, h3, h4, h5, h6, [role]',
  textbox: 'input, textarea, [role]',
  searchbox: 'input, [role]',
  spinbutton: 'input, [role]',
  slider: 'input, [role]',
  checkbox: 'input, [role]',
  radio: 'input, [role]',
  combobox: 'select, input, [role]',
  listbox: 'select, [role]',
  img: 'img, [role]',
  presentation: 'img, [role]',
  option: 'option, [role]',
}
const OTHER_ROLE_CANDIDATES =
  '[role], section, form, nav, main, aside, dialog, ul, ol, li, table, button, textarea'

function candidates(document: Document, selector: string): Element[] | undefined {
  const list = document.querySelectorAll(selector)
  return list.length > MAX_CANDIDATES ? undefined : [...list]
}

/** Elements with this role and exactly this accessible name. */
export function countRoleName(document: Document, role: string, name: string): number | undefined {
  return candidates(document, ROLE_CANDIDATES[role] ?? OTHER_ROLE_CANDIDATES)?.filter(
    (element) => roleOf(element) === role && accessibleName(element) === name,
  ).length
}

/** Form controls whose labels read exactly `text`. */
export function countLabel(document: Document, text: string): number | undefined {
  return candidates(document, 'input, select, textarea')?.filter(
    (element) => labelText(element) === text,
  ).length
}

/** The deepest elements whose visible content is exactly `text`. */
export function countText(document: Document, text: string): number | undefined {
  return candidates(document, 'body *')?.filter(
    (element) =>
      !isUserContent(element) &&
      contentText(element) === text &&
      ![...element.children].some((child) => contentText(child) === text),
  ).length
}

function testIdsOf(element: Element): { attr: (typeof TEST_ATTRIBUTES)[number]; value: string }[] {
  if (isUserAuthored(element)) return []
  return TEST_ATTRIBUTES.flatMap((attr) => {
    const value = element.getAttribute(attr)
    return value !== null && isStableTestId(value) && exactText(value) === value
      ? [{ attr, value }]
      : []
  })
}

/** An id usable as a signal: not generated, not redacted or cut. */
function stableId(element: Element): string | undefined {
  if (isUserAuthored(element)) return undefined
  const id = element.getAttribute('id')
  return id !== null && !isGeneratedId(id) && exactText(id) === id ? id : undefined
}

const CONTAINERS: [NonNullable<TargetDescriptor['container']>['kind'], string][] = [
  ['dialog', 'dialog, [role="dialog"], [role="alertdialog"]'],
  ['menu', '[role="menu"], [role="menubar"]'],
  ['listbox', '[role="listbox"]'],
  ['form', 'form'],
  ['navigation', 'nav, [role="navigation"]'],
  ['table', 'table, [role="table"], [role="grid"]'],
  ['region', 'section[aria-label], section[aria-labelledby], [role="region"]'],
]

function isModal(dialog: Element): boolean {
  if (dialog.getAttribute('aria-modal') === 'true') return true
  try {
    return dialog.matches(':modal')
  } catch {
    return false
  }
}

/** Overlays the target sits in come first: a form inside a modal belongs to the modal. */
const OVERLAYS = new Set(['dialog', 'menu', 'listbox'])

function containerOf(element: Element): TargetDescriptor['container'] {
  const found: [NonNullable<TargetDescriptor['container']>['kind'], Element][] = []
  for (let current = element.parentElement; current; current = current.parentElement) {
    const kind = CONTAINERS.find(([, selector]) => current.matches(selector))?.[0]
    if (kind) found.push([kind, current])
  }
  const [kind, current] = found.find(([candidate]) => OVERLAYS.has(candidate)) ?? found[0] ?? []
  if (!kind || !current) return undefined
  const role = roleOf(current)
  const name = capturedText(accessibleName(current))
  return {
    kind,
    ...(role !== undefined && ROLE.test(role) && { role }),
    ...(name && { accessibleName: name.text }),
    ...(kind === 'dialog' && { modal: isModal(current) }),
  }
}

function anchorsOf(element: Element): TargetDescriptor['anchors'] {
  const anchors: TargetDescriptor['anchors'] = []
  const document = element.ownerDocument
  let distance = 0
  for (
    let current = element.parentElement;
    current && current !== document.body && distance < 20 && anchors.length < 3;
    current = current.parentElement
  ) {
    distance += 1
    const id = stableId(current)
    const [testId] = testIdsOf(current)
    if (!id && !testId) continue
    const role = roleOf(current)
    anchors.push({
      relation: 'ancestor',
      distance,
      tag: current.localName,
      ...(id && { id }),
      ...(testId && { testId }),
      ...(role !== undefined && ROLE.test(role) && { role }),
    })
  }
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].slice(0, MAX_HEADINGS)
  const heading = headings.findLast(
    (candidate) =>
      !candidate.contains(element) &&
      (candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  )
  const headingText = heading && capturedText(contentText(heading))
  if (heading && headingText) {
    anchors.push({
      relation: 'precedingHeading',
      level: Number(heading.localName.slice(1)),
      text: headingText.text,
    })
  }
  if (['input', 'select', 'textarea'].includes(element.localName) && !isUserAuthored(element)) {
    const label = capturedText(labelText(element))
    if (label) anchors.push({ relation: 'label', text: label.text })
  }
  return anchors
}

function locatorsOf(element: Element, role: string | undefined): TargetLocator[] {
  const document = element.ownerDocument
  const locators: TargetLocator[] = []
  // A node the user may have created inside an editable region: only its
  // position on the page describes it.
  const authored = isUserAuthored(element)
  /** Only locators that were counted and match at least the captured element are kept. */
  const add = (count: number | undefined, locator: object) => {
    if (count === undefined || count === 0 || locators.length >= 12) return
    locators.push({
      ...locator,
      scope: 'root',
      matchCount: Math.min(count, 10_000),
    } as TargetLocator)
  }

  for (const { attr, value } of testIdsOf(element)) {
    add(countSelector(document, attributeSelector(attr, value)), {
      strategy: 'testId',
      attr,
      value,
    })
  }
  const id = stableId(element)
  if (id) add(countSelector(document, attributeSelector('id', id)), { strategy: 'id', value: id })

  const name = exactText(accessibleName(element))
  if (role && name) {
    add(countRoleName(document, role, name), { strategy: 'role', role, name, exact: true })
  }
  if (['input', 'select', 'textarea'].includes(element.localName) && !authored) {
    const label = exactText(labelText(element))
    if (label) add(countLabel(document, label), { strategy: 'label', text: label, exact: true })
  }
  for (const [attr, strategy] of authored
    ? []
    : ([
        ['placeholder', 'placeholder'],
        ['alt', 'altText'],
        ['title', 'title'],
      ] as const)) {
    const raw = element.getAttribute(attr)
    // Only when the attribute is stored exactly as the page has it.
    if (raw !== null && exactText(raw) === raw) {
      add(countSelector(document, attributeSelector(attr, raw)), {
        strategy,
        text: raw,
        exact: true,
      })
    }
  }
  if (!isUserContent(element)) {
    const text = exactText(contentText(element))
    if (text) add(countText(document, text), { strategy: 'text', text, exact: true })
  }
  const classes = authored ? [] : [...element.classList].filter(isStableClass).slice(0, 3)
  const type = authored ? null : element.getAttribute('type')
  const css = [
    element.localName,
    ...classes.map((name) => `.${cssEscape(name)}`),
    type !== null && /^[a-z]{1,20}$/.test(type) ? attributeSelector('type', type) : '',
  ].join('')
  if (css !== element.localName && css.length <= MAX_SELECTOR_LENGTH) {
    add(countSelector(document, css), { strategy: 'css', selector: css })
  }
  const path = cssPath(element)
  if (path) add(countSelector(document, path), { strategy: 'cssPath', selector: path })
  return locators
}

function elementOf(element: Element, role: string | undefined): TargetDescriptor['element'] {
  const authored = isUserAuthored(element)
  const name = capturedText(accessibleName(element))
  const text = isUserContent(element) ? undefined : capturedText(contentText(element))
  const rawId = authored ? null : element.getAttribute('id')
  // A generated id is kept as a flagged hint (ADR 0014); a record id is not kept at all.
  const id =
    rawId !== null && !isRecordId(rawId) && exactText(rawId) === rawId
      ? { value: rawId, generated: isGeneratedId(rawId) }
      : undefined
  const classes = authored ? [] : [...element.classList]
  const stable = classes.filter(isStableClass).slice(0, 10)
  const attributes = Object.fromEntries(
    (authored ? [] : DESCRIBING_ATTRIBUTES).flatMap((attr) => {
      const value = element.getAttribute(attr)
      return value === null ? [] : [[attr, capturedText(value)?.text ?? null]]
    }),
  )
  const rect = element.getBoundingClientRect()
  return {
    tag: element.localName,
    ...(role && { role }),
    ...(name && { accessibleName: name.text }),
    ...(text && { text: text.text }),
    testIds: testIdsOf(element),
    ...(id && { id }),
    attributes,
    ...(classes.length > 0 && {
      classes: { stable, droppedCount: Math.min(classes.length - stable.length, 1000) },
    }),
    nthOfType: nthOfType(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  }
}

/**
 * Describes the element under the user's click. `ok: false` with a reason
 * the side panel can show when the element is out of Phase 5's scope or
 * cannot be identified: never a descriptor of some other element.
 */
export function captureTarget(
  hit: Element,
  context: CaptureContext,
  hasClosedShadowRoot?: (element: Element) => boolean,
): CaptureOutcome {
  const { picked, element, promotion } = promote(hit)
  const reason = unsupportedReason(element, hasClosedShadowRoot)
  if (reason) return { ok: false, reason }
  if (!TAG.test(picked.localName))
    return { ok: false, reason: 'This kind of element is not supported.' }

  const rawRole = roleOf(element)
  const role = rawRole !== undefined && ROLE.test(rawRole) ? rawRole : undefined
  const locators = locatorsOf(element, role)
  if (locators.length === 0) {
    return { ok: false, reason: 'This element cannot be identified. Pick another one.' }
  }
  const container = containerOf(element)
  const descriptor: TargetDescriptor = {
    version: 1,
    capturedAt: context.capturedAt.toISOString(),
    capture: {
      extensionVersion: context.extensionVersion,
      ...(context.chromeMajor !== undefined && { chromeMajor: context.chromeMajor }),
      ...(context.viewport && { viewport: context.viewport }),
      pickedTag: picked.localName,
      promotion,
    },
    page: { urlPattern: pagePattern(context.href) },
    framePath: [],
    shadowPath: [],
    ...(container && { container }),
    element: elementOf(element, role),
    anchors: anchorsOf(element),
    locators,
    resolution: RESOLUTION_DEFAULTS,
  }
  // Every field is bounded; only an extreme page needs context trimmed.
  if (JSON.stringify(descriptor).length > MAX_DESCRIPTOR_LENGTH) descriptor.anchors = []
  if (JSON.stringify(descriptor).length > MAX_DESCRIPTOR_LENGTH) {
    return { ok: false, reason: 'This element carries too much data to store. Pick another one.' }
  }
  return { ok: true, element, descriptor }
}
