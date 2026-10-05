import { describe, expect, it } from 'vitest'

import { isCrossSiteRequest, type CsrfRequest } from '../src/http/csrf-guard.js'

const allowed = new Set(['http://localhost:5173', 'http://localhost:4173'])

function request(overrides: Partial<CsrfRequest>): CsrfRequest {
  return {
    method: 'POST',
    origin: undefined,
    secFetchSite: undefined,
    authorization: undefined,
    ...overrides,
  }
}

describe('isCrossSiteRequest', () => {
  it.each([
    ['allowed dashboard origin', { origin: 'http://localhost:5173' }, false],
    ['allowed preview origin', { origin: 'http://localhost:4173' }, false],
    ['foreign origin', { origin: 'https://evil.example' }, true],
    ['same host, other port', { origin: 'http://localhost:3000' }, true],
    ['opaque origin (null)', { origin: 'null' }, true],
    ['no Origin, Sec-Fetch-Site same-origin', { secFetchSite: 'same-origin' }, false],
    ['no Origin, Sec-Fetch-Site same-site', { secFetchSite: 'same-site' }, true],
    ['no Origin, Sec-Fetch-Site cross-site', { secFetchSite: 'cross-site' }, true],
    ['no Origin, Sec-Fetch-Site none', { secFetchSite: 'none' }, true],
    ['no browser headers at all (curl, servers)', {}, false],
    [
      'bearer request from anywhere',
      { origin: 'https://evil.example', authorization: 'Bearer x' },
      false,
    ],
  ] satisfies [string, Partial<CsrfRequest>, boolean][])('%s', (_name, overrides, expected) => {
    expect(isCrossSiteRequest(request(overrides), allowed)).toBe(expected)
  })

  it.each(['GET', 'HEAD', 'OPTIONS'])('never blocks %s', (method) => {
    expect(isCrossSiteRequest(request({ method, origin: 'https://evil.example' }), allowed)).toBe(
      false,
    )
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('checks %s', (method) => {
    expect(isCrossSiteRequest(request({ method, origin: 'https://evil.example' }), allowed)).toBe(
      true,
    )
  })
})
