/**
 * Text as captured into a target descriptor (ADR 0014, capture step 7).
 *
 * Every piece of page text goes through `capturedText`, which normalizes
 * whitespace, redacts what looks like personal data and caps the length.
 * A value that was redacted or cut no longer equals what the page shows, so
 * `exact` is false and callers must not use it as an exact locator: locators
 * are only built from values that matched the page as they are.
 *
 * Redaction is a heuristic (emails, long digit runs, card-like and
 * phone-like numbers). It does not guarantee that no personal data remains;
 * the side panel shows every captured value so the author can review or
 * remove the target before saving.
 */
export const MAX_CAPTURED_LENGTH = 80

/** Collapses whitespace like the accessibility tree and Playwright's text matching. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g
/** 5 or more digits, possibly grouped with spaces, dots or dashes (ids, phones, cards). */
const LONG_NUMBER = /\d(?:[\s.-]?\d){4,}/g

export interface CapturedText {
  text: string
  /** True when `text` is exactly the page's (normalized) text. */
  exact: boolean
}

export function redact(value: string): { text: string; redacted: boolean } {
  const text = value.replace(EMAIL, '[email]').replace(LONG_NUMBER, '[number]')
  return { text, redacted: text !== value }
}

/** Normalized, redacted and capped; `undefined` when nothing is left. */
export function capturedText(raw: string | null | undefined): CapturedText | undefined {
  if (raw === null || raw === undefined) return undefined
  const normalized = normalizeText(raw)
  if (normalized === '') return undefined
  const { text, redacted } = redact(normalized)
  if (text.length <= MAX_CAPTURED_LENGTH) return { text, exact: !redacted }
  return { text: `${text.slice(0, MAX_CAPTURED_LENGTH - 1).trimEnd()}…`, exact: false }
}

/** The value only when it can be used as-is (not redacted, not cut). */
export function exactText(raw: string | null | undefined): string | undefined {
  const captured = capturedText(raw)
  return captured?.exact ? captured.text : undefined
}
