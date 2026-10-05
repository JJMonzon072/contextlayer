import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { serializeError } from '../src/logger.js'
import { hashPassword, verifyPassword } from '../src/modules/auth/passwords.js'
import {
  clearedSessionCookieOptions,
  sessionCookieOptions,
} from '../src/modules/auth/session-cookie.js'
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from '../src/modules/auth/session-token.js'

describe('session tokens', () => {
  it('are 256 random bits in base64url and differ every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateSessionToken))

    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(isWellFormedSessionToken(token)).toBe(true)
  })

  it('are stored as a 32-byte SHA-256 digest, never as themselves', () => {
    const token = generateSessionToken()
    const hash = hashSessionToken(token)

    expect(hash).toHaveLength(32)
    expect(hash.toString('base64url')).not.toBe(token)
  })

  it('reject malformed cookie values before any lookup', () => {
    for (const value of ['', 'short', `${generateSessionToken()}x`, 'a'.repeat(42) + '!']) {
      expect(isWellFormedSessionToken(value)).toBe(false)
    }
  })
})

describe('session cookie', () => {
  it('is HttpOnly, Secure, SameSite=Strict, Path=/ and lives as long as the session', () => {
    expect(
      sessionCookieOptions({ cookieName: 'x', idleTimeoutMs: 1, absoluteTimeoutMs: 8 * 3_600_000 }),
    ).toEqual({ httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 28_800 })
  })

  it('is cleared with the same attributes so a __Host- cookie is actually replaced', () => {
    expect(clearedSessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    })
  })
})

describe('passwords', () => {
  it('are hashed with argon2id at the OWASP minimum parameters', async () => {
    const hash = await hashPassword('correct horse battery')

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(hash).not.toContain('correct horse battery')
  })

  it('verify only the right password and never throw on a malformed hash', async () => {
    const hash = await hashPassword('correct horse battery')

    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true)
    expect(await verifyPassword(hash, 'wrong horse battery')).toBe(false)
    expect(await verifyPassword('not-a-phc-string', 'anything')).toBe(false)
  })
})

describe('serializeError', () => {
  it('drops query parameters and database details before they reach the logs', () => {
    const driverError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (lower(email))=(alice@example.com) already exists.',
    })
    const error = new DrizzleQueryError(
      'insert into "users" ...',
      ['alice@example.com', '$argon2id$secret-hash'],
      driverError,
    )

    const serialized = JSON.stringify(serializeError(error))

    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).not.toContain('secret-hash')
    expect(serialized).toContain('23505')
  })
})
