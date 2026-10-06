import { normalizeText } from './text'

/**
 * Role and accessible name, computed in JavaScript because a content script
 * cannot read the accessibility tree (ADR 0014, capture step 5).
 *
 * This is a deliberately small subset of WAI-ARIA role mapping and of
 * accname 1.2, not a conforming implementation: explicit roles, the implicit
 * roles of common elements, and names from `aria-labelledby`, `aria-label`,
 * `<label>`, `alt`, element content and `title`/`placeholder`. The same
 * functions are used to capture a name and to count the elements that share
 * it, so `matchCount` and the stored name follow one definition.
 *
 * What users typed is never read, whatever path asks for text: form controls
 * (`input`, `textarea`, `select`) and editable content are excluded at the
 * root of every extraction and at every node below it, including content
 * that is editable only because an ancestor is (an editing host, a
 * non-editable island inside one, or a document in design mode). Inside an
 * editable region not even attributes are read, since the user may have
 * pasted those nodes; the editing host's own attributes are the page's.
 * This exclusion is separate from the redaction of allowed text (`text.ts`),
 * which is a heuristic and does not find every piece of personal data.
 */

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
  password: 'textbox',
}

const TAG_ROLES: Record<string, string> = {
  button: 'button',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  dialog: 'dialog',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
}

const VALID_ROLE = /^[a-z][a-z-]{0,39}$/

/** The element's role: an explicit valid `role`, else its implicit role, else undefined. */
export function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase()
  if (explicit && VALID_ROLE.test(explicit)) return explicit
  const tag = element.localName
  if (tag === 'a' || tag === 'area') return element.hasAttribute('href') ? 'link' : undefined
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase()
    return type === 'hidden' ? undefined : (INPUT_ROLES[type] ?? 'textbox')
  }
  if (tag === 'select') {
    const multiple = element.hasAttribute('multiple') || Number(element.getAttribute('size')) > 1
    return multiple ? 'listbox' : 'combobox'
  }
  if (tag === 'img') return element.getAttribute('alt') === '' ? 'presentation' : 'img'
  if (tag === 'form') return element.hasAttribute('aria-label') ? 'form' : undefined
  if (tag === 'section') return element.hasAttribute('aria-label') ? 'region' : undefined
  return TAG_ROLES[tag]
}

/** Roles whose accessible name comes from their content (accname "name from content"). */
const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'checkbox',
  'radio',
  'switch',
  'cell',
  'columnheader',
  'rowheader',
  'tooltip',
])

/** `contenteditable` values that make an element an editing host. */
const EDITING_HOST_VALUES = new Set(['', 'true', 'plaintext-only'])

/**
 * The nearest element, `element` or an ancestor, that makes it editable: an
 * editing host, or the root element of a document in design mode. Values such
 * as `false` (a non-editable island) or `inherit` do not end the search: what
 * sits inside an editing host is the user's content either way.
 */
export function editingHost(element: Element): Element | undefined {
  const document = element.ownerDocument
  if (document.designMode === 'on') return document.documentElement
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = current.getAttribute('contenteditable')
    if (value !== null && EDITING_HOST_VALUES.has(value.trim().toLowerCase())) return current
  }
  return undefined
}

/** Elements whose content a user may have typed or chosen: never read. */
export function isUserContent(element: Element): boolean {
  const tag = element.localName
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return editingHost(element) !== undefined
}

/** A form control or an editing host by its own markup (ancestors aside). */
function isOwnUserContent(element: Element): boolean {
  const tag = element.localName
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  const value = element.getAttribute('contenteditable')
  return value !== null && EDITING_HOST_VALUES.has(value.trim().toLowerCase())
}

/**
 * Nodes inside an editable region (not its host): the user may have created
 * them, so neither their text nor their attributes are read.
 */
export function isUserAuthored(element: Element): boolean {
  const parent = element.parentElement
  return parent !== null && editingHost(parent) !== undefined
}

function isHidden(element: Element): boolean {
  return (
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    element.localName === 'script' ||
    element.localName === 'style' ||
    element.localName === 'template' ||
    element.localName === 'noscript'
  )
}

/**
 * Visible text of a subtree without user content: no form-control values, no
 * editable regions, no hidden or script nodes; images contribute their alt.
 * The root is checked like every node below it: an editable or hidden root
 * (unlike accname, also one referenced by `aria-labelledby`) gives ''.
 * Bounded so a huge subtree does not make one capture slow.
 */
export function contentText(root: Element, limit = 400): string {
  if (isHidden(root) || isUserContent(root)) return ''
  let text = ''
  const visit = (node: Node): void => {
    if (text.length > limit) return
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    // The root and its ancestors passed `isUserContent`: below it, a node is
    // user content when it, or a node the walk already skipped, is.
    if (isHidden(element) || isOwnUserContent(element)) return
    if (element.localName === 'img') {
      text += ` ${element.getAttribute('alt') ?? ''} `
      return
    }
    for (const child of element.childNodes) visit(child)
    if (element.localName === 'br' || element.localName === 'p' || element.localName === 'div') {
      text += ' '
    }
  }
  for (const child of root.childNodes) visit(child)
  return normalizeText(text)
}

function labelsOf(element: Element): Element[] {
  const labels: Element[] = []
  const id = element.getAttribute('id')
  if (id) {
    for (const label of element.ownerDocument.querySelectorAll('label[for]')) {
      if (label.getAttribute('for') === id) labels.push(label)
    }
  }
  const wrapping = element.closest('label')
  if (wrapping && !labels.includes(wrapping)) labels.push(wrapping)
  return labels
}

/** The text of the labels of a form control (its own value excluded). */
export function labelText(element: Element): string {
  return normalizeText(
    labelsOf(element)
      .map((label) => contentText(label))
      .join(' '),
  )
}

/** The accessible name, normalized; '' when there is none (always for user-authored nodes). */
export function accessibleName(element: Element): string {
  if (isUserAuthored(element)) return ''
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const document = element.ownerDocument
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((target): target is HTMLElement => target !== null && !isUserContent(target))
      .map((target) => contentText(target))
    const name = normalizeText(parts.join(' '))
    if (name) return name
  }
  const ariaLabel = normalizeText(element.getAttribute('aria-label') ?? '')
  if (ariaLabel) return ariaLabel

  const tag = element.localName
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const type = (element.getAttribute('type') ?? '').toLowerCase()
    // The label of a submit button is its value attribute, written by the
    // page's author; text fields' values are what users typed: never read.
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
      const authored = normalizeText(element.getAttribute('value') ?? '')
      if (authored) return authored
    }
    if (tag === 'input' && type === 'image') {
      const alt = normalizeText(element.getAttribute('alt') ?? '')
      if (alt) return alt
    }
    const label = labelText(element)
    if (label) return label
    return normalizeText(element.getAttribute('title') ?? element.getAttribute('placeholder') ?? '')
  }
  if (tag === 'img' || tag === 'area') {
    const alt = normalizeText(element.getAttribute('alt') ?? '')
    if (alt) return alt
  }
  const role = roleOf(element)
  if (role !== undefined && NAME_FROM_CONTENT.has(role) && !isUserContent(element)) {
    const content = contentText(element)
    if (content) return content
  }
  return normalizeText(element.getAttribute('title') ?? '')
}
