import type { UrlPattern } from '@contextlayer/shared'

import { isGeneratedId } from './identity'

/** URLPattern syntax characters that a literal path segment must escape. */
const PATTERN_SYNTAX = /[:*?+(){}\\]/g
const MAX_PATTERN_PART = 256

/**
 * Path segments that identify a record or a person rather than a page:
 * numbers, ids, hashes, emails and long tokens. They become named groups.
 */
function isDynamicSegment(segment: string): boolean {
  return (
    /\d{2,}/.test(segment) || /%40|@/.test(segment) || segment.length > 40 || isGeneratedId(segment)
  )
}

/**
 * A conservative page pattern for the current URL (ADR 0014): scheme, host,
 * port and path only. The query string, the fragment and credentials are
 * never kept, and dynamic path segments become `:id`, `:id2`… so a pattern
 * describes the page, not the record or person shown on it
 * (`/customers/48213/edit` → `/customers/:id/edit`). A path that would still
 * be too long is replaced by `/*` rather than stored partially.
 */
export function pagePattern(href: string): UrlPattern {
  const url = new URL(href)
  let groups = 0
  const segments = url.pathname.split('/').map((segment) => {
    if (segment === '' || !isDynamicSegment(segment)) return segment.replace(PATTERN_SYNTAX, '\\$&')
    groups += 1
    return groups === 1 ? ':id' : `:id${String(groups)}`
  })
  const pathname = segments.join('/') || '/'
  return {
    protocol: url.protocol.replace(/:$/, ''),
    ...(url.hostname !== '' && { hostname: url.hostname }),
    ...(url.port !== '' && { port: url.port }),
    pathname: pathname.length <= MAX_PATTERN_PART ? pathname : '/*',
  }
}
