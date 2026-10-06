/**
 * Heuristics that tell generated or unstable identifiers from stable ones
 * (ADR 0014, capture step 4). They are heuristics, not a perfect detector: a
 * false positive only loses one signal, a false negative stores an identifier
 * that may not survive the next build. The same tests apply everywhere an id
 * or a class could end up in the descriptor: locators, CSS paths, anchors and
 * container ids.
 */

/**
 * Character-class transitions, after Playwright's `isGuidLike`: hashes and
 * generated tokens switch between lower case, upper case and digits often
 * (`kPxNtw`, `a1b2c3d4`), words do not (`billing-save`, `SaveButton`).
 */
export function isGuidLike(value: string): boolean {
  let last: string | undefined
  let transitions = 0
  let counted = 0
  for (const char of value) {
    if (char === '-' || char === '_') continue
    counted += 1
    const kind =
      char >= 'a' && char <= 'z'
        ? 'lower'
        : char >= 'A' && char <= 'Z'
          ? 'upper'
          : char >= '0' && char <= '9'
            ? 'digit'
            : 'other'
    // `fooBar`: an upper-to-lower switch is how words start, not noise.
    if (kind === 'lower' && last === 'upper') {
      last = kind
      continue
    }
    if (last !== undefined && last !== kind) transitions += 1
    last = kind
  }
  return counted >= 4 && transitions >= counted / 4
}

const GENERATED_ID_PATTERNS = [
  /^:r[0-9a-z]+:$/i, // React useId (18)
  /^«r[0-9a-z]+»$/i, // React useId (19.1)
  /^_r_[0-9a-z]+_$/i, // React useId (19.2)
  /^v-\d+(-\d+)*$/, // Vue 3.5 useId
  /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i, // UUID
  /\d{4,}/, // long numbers: row ids, timestamps
  /[-_:]\d+$/, // counters: mat-input-3, headlessui-menu-1, radix-:r1
  /^(ember|ext-gen|yui_|gwt-|j_id|pt\d)/i, // framework id generators
]

/** A hash-like last segment (two or more digits among letters): `save-7f3a9c21`, `field_x8Kq2`. */
function hasHashSuffix(value: string): boolean {
  const segment = value.split(/[-_:.]/).pop() ?? ''
  return segment.length >= 5 && /\d.*\d/.test(segment) && /[a-z]/i.test(segment)
}

export function isGeneratedId(value: string): boolean {
  if (value.trim() === '' || value.length > 80) return true
  return (
    GENERATED_ID_PATTERNS.some((pattern) => pattern.test(value)) ||
    hasHashSuffix(value) ||
    isGuidLike(value)
  )
}

/** A record id (UUID, long number): never stored, not even flagged as generated. */
export function isRecordId(value: string): boolean {
  return (
    /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i.test(value) ||
    /\d{4,}/.test(value)
  )
}

/** A test attribute value written by a person, not a counter or a row id. */
export function isStableTestId(value: string): boolean {
  return value.trim() !== '' && value.length <= 80 && !/\d{4,}/.test(value) && !isGuidLike(value)
}

const CSS_IN_JS = [
  /^css-[0-9a-z]+$/i, // Emotion
  /^sc-[a-z]+$/i, // styled-components component id
  /^jss\d+$/, // JSS
  /-\d+$/, // makeStyles-root-12, counters
  /__[A-Za-z0-9_-]{5,}$/, // CSS Modules: Button_primary__3xYz1
  /^_[A-Za-z0-9]{5,}$/, // CSS Modules (hash only)
]

const STATE =
  /^(is-|has-)?(active|selected|open|opened|closed|focus|focused|focus-visible|hover|hovered|pressed|disabled|enabled|checked|current|visible|hidden|loading|loaded|expanded|collapsed|error|invalid|valid|dirty)$/
const ANGULAR_STATE =
  /^ng-(touched|untouched|pristine|dirty|valid|invalid|pending|star-inserted|animating)$/

/** Tailwind-like utilities describe looks, not identity. */
const UTILITY =
  /^-?(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|w|h|min-w|max-w|min-h|max-h|size|gap|gap-x|gap-y|space-x|space-y|text|font|leading|tracking|bg|from|via|to|border|border-[trblxy]|rounded|rounded-[trbl]{1,2}|shadow|opacity|z|inset|top|right|bottom|left|flex|grid|grid-cols|grid-rows|col|row|items|justify|content|self|place|order|basis|grow|shrink|overflow|whitespace|break|truncate|cursor|select|pointer-events|transition|duration|ease|delay|animate|transform|scale|rotate|translate-[xy]|skew|origin|fill|stroke|ring|ring-offset|outline|divide|aspect|object|align|line-clamp|decoration|underline-offset|accent|caret|will-change|sr-only|not-sr-only|block|inline|inline-block|inline-flex|hidden|contents|static|fixed|absolute|relative|sticky|visible|invisible|underline|uppercase|lowercase|capitalize|italic|antialiased|container)(-|$)/

/**
 * A class that says what an element is (`btn-primary`, `customer-form`), as
 * opposed to a hash, a state, a utility, or a name the schema cannot store.
 */
export function isStableClass(name: string): boolean {
  if (!/^-?[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(name)) return false
  if (CSS_IN_JS.some((pattern) => pattern.test(name))) return false
  if (STATE.test(name) || ANGULAR_STATE.test(name) || UTILITY.test(name)) return false
  return !hasHashSuffix(name) && !isGuidLike(name)
}
