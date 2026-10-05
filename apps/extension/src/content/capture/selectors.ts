import { isGeneratedId, isStableTestId } from './identity'

/** Longest selector a descriptor may store; a longer one is dropped, never cut. */
export const MAX_SELECTOR_LENGTH = 512
/** How far up a structural path may go before it is not worth storing. */
const MAX_PATH_DEPTH = 24

/**
 * CSS identifier escaping per CSSOM `CSS.escape` (implemented here so capture
 * and its tests behave the same in Chrome and in jsdom, which lacks it).
 */
export function cssEscape(value: string): string {
  let result = ''
  const first = value.charCodeAt(0)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const char = value.charAt(index)
    if (code === 0) {
      result += '\uFFFD'
    } else if (
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f ||
      (index === 0 && code >= 0x30 && code <= 0x39) ||
      (index === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d)
    ) {
      result += `\\${code.toString(16)} `
    } else if (index === 0 && value.length === 1 && code === 0x2d) {
      result += `\\${char}`
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      result += char
    } else {
      result += `\\${char}`
    }
  }
  return result
}

/** A double-quoted CSS string: `[data-testid="a\"b"]`. */
export function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`).replace(/[\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`
}

/** `[attr="value"]` matching the attribute exactly. */
export function attributeSelector(attr: string, value: string): string {
  return `[${attr}=${cssString(value)}]`
}

/** Number of elements a selector matches in `root`; undefined if the selector is invalid. */
export function countSelector(root: ParentNode, selector: string): number | undefined {
  try {
    return root.querySelectorAll(selector).length
  } catch {
    return undefined
  }
}

function tagOf(element: Element): string {
  return element.localName
}

/** 1-based index among siblings of the same tag, and how many there are. */
export function nthOfType(element: Element): { index: number; count: number } {
  const parent = element.parentElement
  if (!parent) return { index: 1, count: 1 }
  const same = [...parent.children].filter((child) => child.localName === element.localName)
  return { index: same.indexOf(element) + 1, count: same.length }
}

/** An ancestor that can start a path: a stable, unique id or test id. */
function pathAnchor(element: Element, document: Document): string | undefined {
  const id = element.getAttribute('id')
  if (id && !isGeneratedId(id)) {
    const selector = `${tagOf(element)}#${cssEscape(id)}`
    if (countSelector(document, selector) === 1) return selector
  }
  const testId = element.getAttribute('data-testid')
  if (testId && isStableTestId(testId)) {
    const selector = `${tagOf(element)}${attributeSelector('data-testid', testId)}`
    if (countSelector(document, selector) === 1) return selector
  }
  return undefined
}

/**
 * A structural path (`form#billing-form > div:nth-of-type(4) > button`): tags
 * and positions from the nearest ancestor with a stable unique id or test id,
 * or from `body`. Generated ids are never used, not even here. `undefined`
 * when the path would be longer than a descriptor may store.
 */
export function cssPath(element: Element): string | undefined {
  const document = element.ownerDocument
  const parts: string[] = []
  let current: Element | null = element
  let rooted = false
  for (let depth = 0; current && depth < MAX_PATH_DEPTH; depth += 1) {
    if (current === document.body || current === document.documentElement) {
      parts.unshift(tagOf(current))
      rooted = true
      break
    }
    // The element itself is anchored by its own locators, not by its path.
    const anchor = current === element ? undefined : pathAnchor(current, document)
    if (anchor) {
      parts.unshift(anchor)
      rooted = true
      break
    }
    const { index, count } = nthOfType(current)
    parts.unshift(count > 1 ? `${tagOf(current)}:nth-of-type(${String(index)})` : tagOf(current))
    current = current.parentElement
  }
  const selector = parts.join(' > ')
  // Detached, or deeper than worth storing: no path rather than a partial one.
  if (!rooted || selector.length > MAX_SELECTOR_LENGTH) return undefined
  return selector
}
