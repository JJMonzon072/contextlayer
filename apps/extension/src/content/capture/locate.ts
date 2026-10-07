import { accessibleName, contentText, isUserContent, labelText, roleOf } from './accessible'

/**
 * The elements a locator selects, by the definitions capture uses for its
 * `matchCount` (ADR 0014): capture counts them, the player (Phase 6) looks
 * for them, so a stored count and a later search mean the same thing.
 */

/** Above this many candidates a search is not attempted: `undefined`, never a guess. */
export const MAX_CANDIDATES = 5_000

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

/** `querySelectorAll`, or `undefined` for an invalid selector or too many matches. */
export function findBySelector(root: ParentNode, selector: string): Element[] | undefined {
  let list: NodeListOf<Element>
  try {
    list = root.querySelectorAll(selector)
  } catch {
    return undefined
  }
  return list.length > MAX_CANDIDATES ? undefined : [...list]
}

/** Elements with this role and exactly this accessible name. */
export function findByRoleName(document: Document, role: string, name: string) {
  return findBySelector(document, ROLE_CANDIDATES[role] ?? OTHER_ROLE_CANDIDATES)?.filter(
    (element) => roleOf(element) === role && accessibleName(element) === name,
  )
}

/** Form controls whose labels read exactly `text`. */
export function findByLabel(document: Document, text: string) {
  return findBySelector(document, 'input, select, textarea')?.filter(
    (element) => labelText(element) === text,
  )
}

/** The deepest elements whose visible content is exactly `text`. */
export function findByText(document: Document, text: string) {
  return findBySelector(document, 'body *')?.filter(
    (element) =>
      !isUserContent(element) &&
      contentText(element) === text &&
      ![...element.children].some((child) => contentText(child) === text),
  )
}
