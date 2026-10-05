/**
 * The WHATWG URL parser exists in every runtime these contracts run in (Node,
 * browsers, extension service workers), but this package is compiled without
 * DOM or Node typings, so only the members used here are declared.
 */
interface ParsedUrl {
  readonly protocol: string
  readonly username: string
  readonly password: string
  readonly hostname: string
  readonly port: string
  readonly origin: string
}

const UrlConstructor = (globalThis as unknown as { URL: new (input: string) => ParsedUrl }).URL

export function parseUrl(input: string): ParsedUrl | undefined {
  try {
    return new UrlConstructor(input)
  } catch {
    return undefined
  }
}

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`)
const IPV6_HOST = /^\[[0-9a-f:.]+\]$/

/** A host name as the URL parser normalizes it: lower case, punycode, no trailing dot. */
export function isValidHostname(hostname: string): boolean {
  return hostname.length <= 253 && (HOSTNAME.test(hostname) || IPV6_HOST.test(hostname))
}

/** True for C0/C1 control characters other than tab and line feed. */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x09 || code === 0x0a) continue
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}
