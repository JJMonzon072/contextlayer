import { z } from 'zod'

import { hasControlCharacters, isValidHostname, parseUrl } from './url.js'

/**
 * Application origins decide, from Phase 4, which sites the extension asks
 * access to. Only exact origins are accepted (scheme, host, optional port) and
 * they are stored normalized, the way browsers serialize `location.origin`.
 */
export const MAX_APPLICATION_ORIGINS = 20
export const MAX_ORIGIN_LENGTH = 255

export type OriginResult = { ok: true; origin: string } | { ok: false; error: string }

const fail = (error: string): OriginResult => ({ ok: false, error })

/**
 * Accepts `https://app.example.com`, `http://localhost:5173` or
 * `https://app.example.com:8443`, with any letter case and an optional trailing
 * slash, and returns the serialized origin (lower case, default port removed,
 * international host names in punycode). Rejects paths, query strings,
 * fragments, credentials, wildcards and schemes other than http and https.
 */
export function parseOrigin(input: string): OriginResult {
  const value = input.trim()
  if (value === '') return fail('Enter an origin such as https://app.example.com.')
  if (value.length > MAX_ORIGIN_LENGTH) {
    return fail(`Use at most ${String(MAX_ORIGIN_LENGTH)} characters.`)
  }
  if (value.includes('*')) return fail('Wildcards are not supported: list each origin separately.')
  if (/\s/.test(value) || hasControlCharacters(value)) {
    return fail('Origins cannot contain spaces.')
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)
  const protocol = scheme?.[1]?.toLowerCase()
  if (!scheme || protocol === undefined) {
    return fail('Include the scheme, for example https://app.example.com.')
  }
  if (protocol !== 'https' && protocol !== 'http') {
    return fail('Only http and https origins are supported.')
  }

  // Checked on the raw text: the URL parser silently drops an empty `?` or `#`.
  const rest = value.slice(scheme[0].length)
  const authorityEnd = rest.search(/[/?#]/)
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd)
  if (authority.includes('@')) return fail('Origins cannot contain a user name or password.')
  if (tail !== '' && tail !== '/') {
    return fail('Remove the path, query or fragment: an origin is only scheme, host and port.')
  }

  const url = parseUrl(value)
  if (!url || !isValidHostname(url.hostname)) {
    return fail('Enter a valid host name, for example https://app.example.com.')
  }
  if (url.port !== '' && Number(url.port) < 1) return fail('Use a port between 1 and 65535.')
  return { ok: true, origin: url.origin }
}

/** Validates one origin and normalizes it in place (no type change, ADR 0010). */
export const originSchema = z
  .string()
  .max(MAX_ORIGIN_LENGTH * 4)
  .superRefine((value, ctx) => {
    const result = parseOrigin(value)
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.error })
  })
  .overwrite((value) => {
    const result = parseOrigin(value)
    return result.ok ? result.origin : value
  })

export const originListSchema = z
  .array(originSchema)
  .min(1, 'Add at least one origin.')
  .max(MAX_APPLICATION_ORIGINS, `Use at most ${String(MAX_APPLICATION_ORIGINS)} origins.`)
  .superRefine((origins, ctx) => {
    const seen = new Set<string>()
    origins.forEach((origin, index) => {
      if (seen.has(origin)) {
        ctx.addIssue({ code: 'custom', message: `${origin} is listed twice.`, path: [index] })
      }
      seen.add(origin)
    })
  })

/**
 * The Chrome match pattern for exactly one origin, used for host permissions
 * and content-script registrations. The port is always explicit, including the
 * scheme default that `URL.origin` omits: a pattern without a port matches
 * every port of the host. `https://crm.example.com` → `https://crm.example.com:443/*`.
 */
export function originMatchPattern(origin: string | URL): string {
  const url = typeof origin === 'string' ? new URL(origin) : origin
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.protocol}//${url.hostname}:${port}/*`
}
