import { hash, verify } from '@node-rs/argon2'

/**
 * argon2id with the OWASP minimum parameters (19 MiB, 2 passes, 1 lane), which
 * are also @node-rs/argon2's defaults; argon2id is its default algorithm. They
 * are spelled out so a library upgrade cannot silently weaken them.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS)
}

/** False for a wrong password and for a malformed stored hash (never throws). */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

let dummyHash: Promise<string> | undefined

/**
 * A real hash to verify against when the email is unknown, so a failed login
 * costs the same argon2id work whether or not the account exists.
 */
export function timingEqualizerHash(): Promise<string> {
  dummyHash ??= hash('contextlayer-timing-equalizer', ARGON2_OPTIONS)
  return dummyHash
}
