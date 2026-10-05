import { createHash, randomBytes } from 'node:crypto'

const TOKEN_BYTES = 32

/** 256 random bits, base64url (43 characters): the value that lives only in the cookie. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * What the database stores. A fast hash is enough: the input is 256 random
 * bits, so there is nothing to brute-force (ADR 0015).
 */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/** Rejects junk before it reaches the database. */
export function isWellFormedSessionToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}
