import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  CREDENTIAL_PREFIXES,
  credentialPattern,
  PKCE_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
  type CredentialKind,
} from '@contextlayer/shared'

const RANDOM_BYTES = 32

/** A new opaque credential: its type prefix and 256 bits from the CSPRNG. */
export function generateCredential(kind: CredentialKind): string {
  return `${CREDENTIAL_PREFIXES[kind]}${randomBytes(RANDOM_BYTES).toString('base64url')}`
}

/**
 * What the database stores. A fast hash is enough for 256 random bits, as for
 * dashboard sessions (ADR 0015); the prefix is hashed too, so a value of one
 * type never matches a row of another.
 */
export function hashCredential(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function isCredential(kind: CredentialKind, value: string): boolean {
  return credentialPattern(kind).test(value)
}

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(code_verifier))). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** Constant-time comparison of the derived challenge with the stored one. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!PKCE_VERIFIER_PATTERN.test(verifier) || !PKCE_CHALLENGE_PATTERN.test(challenge)) {
    return false
  }
  const expected = Buffer.from(challenge)
  const actual = Buffer.from(pkceChallenge(verifier))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
