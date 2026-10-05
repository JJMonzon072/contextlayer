import { z } from 'zod'

import { hasControlCharacters } from './url.js'

/**
 * A URLPattern init object (`{ pathname: '/projects/:id' }`), evaluated by the
 * extension from Phase 6. Node 22 has no URLPattern, so the API checks shape and
 * size only. Pages are stored as patterns, never as raw URLs, because captured
 * URLs can carry personal data from customer applications.
 */
const patternPart = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\s/.test(value) && !hasControlCharacters(value), {
    message: 'URL patterns cannot contain spaces or control characters.',
  })

export const urlPatternSchema = z
  .strictObject({
    protocol: patternPart.optional(),
    hostname: patternPart.optional(),
    port: patternPart.optional(),
    pathname: patternPart.optional(),
    search: patternPart.optional(),
    hash: patternPart.optional(),
  })
  .refine((pattern) => Object.values(pattern).some(Boolean), {
    message: 'A URL pattern needs at least one component.',
  })

export type UrlPattern = z.infer<typeof urlPatternSchema>
