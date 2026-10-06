import type { UrlPattern } from '@contextlayer/shared'

/**
 * Whether a page is one a stored URL pattern describes (ADR 0014, page
 * matching), with the browser's `URLPattern` (Chrome 95+). Shared by the
 * worker (a guide's start page) and the player (each step's page), so both
 * read stored patterns the same way:
 * - `null` means any page (of the origin the guide is registered for);
 * - components a pattern leaves out match anything, as URLPattern defines;
 * - a pattern URLPattern refuses is `invalid`, never treated as a match.
 */
export type PageMatch = 'match' | 'no-match' | 'invalid'

export function matchPage(pattern: UrlPattern | null, href: string): PageMatch {
  if (pattern === null) return 'match'
  const init: URLPatternInit = {}
  for (const [key, value] of Object.entries(pattern)) {
    if (typeof value === 'string') init[key as keyof UrlPattern] = value
  }
  try {
    return new URLPattern(init).test(href) ? 'match' : 'no-match'
  } catch {
    return 'invalid'
  }
}
