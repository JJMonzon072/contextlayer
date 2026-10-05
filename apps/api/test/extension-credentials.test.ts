import { describe, expect, it } from 'vitest'

import {
  generateCredential,
  hashCredential,
  isCredential,
  pkceChallenge,
  verifyPkce,
} from '../src/modules/extension/credentials.js'

describe('extension credentials', () => {
  it('are opaque, prefixed by type and 256 bits of randomness', () => {
    const access = generateCredential('access')
    expect(access).toMatch(/^cla_[A-Za-z0-9_-]{43}$/)
    expect(generateCredential('refresh')).toMatch(/^clr_/)
    expect(generateCredential('code')).toMatch(/^clc_/)
    expect(generateCredential('access')).not.toBe(access)
  })

  it('are not interchangeable: each type has its own format', () => {
    const refresh = generateCredential('refresh')
    expect(isCredential('refresh', refresh)).toBe(true)
    expect(isCredential('access', refresh)).toBe(false)
    expect(isCredential('code', refresh)).toBe(false)
  })

  it('are stored as 32-byte SHA-256 hashes', () => {
    expect(hashCredential(generateCredential('code'))).toHaveLength(32)
  })
})

describe('PKCE S256', () => {
  // RFC 7636, appendix B.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

  it('derives the challenge of the RFC example', () => {
    expect(pkceChallenge(verifier)).toBe(challenge)
    expect(verifyPkce(verifier, challenge)).toBe(true)
  })

  it('rejects another verifier, a plain challenge and malformed input', () => {
    expect(verifyPkce(`${verifier.slice(0, -1)}A`, challenge)).toBe(false)
    expect(verifyPkce(verifier, verifier)).toBe(false)
    expect(verifyPkce('short', challenge)).toBe(false)
    expect(verifyPkce(verifier, 'not a challenge')).toBe(false)
  })
})
