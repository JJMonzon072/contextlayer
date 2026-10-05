import { PKCE_VERIFIER_PATTERN } from '@contextlayer/shared'
import { describe, expect, it } from 'vitest'

import { randomToken, s256 } from '../src/background/pkce'

describe('PKCE', () => {
  it('computes the RFC 7636 S256 challenge', async () => {
    // RFC 7636, appendix B.
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('draws 256-bit base64url values usable as verifier and state', () => {
    const values = new Set(Array.from({ length: 50 }, () => randomToken()))

    expect(values.size).toBe(50)
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(value).toMatch(PKCE_VERIFIER_PATTERN)
    }
  })
})
