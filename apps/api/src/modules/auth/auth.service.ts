import type {
  LoginRequest,
  RegisterRequest,
  SessionResponse,
  User,
  WorkspaceSummary,
} from '@contextlayer/shared'

import type { SessionConfig } from '../../config/env.js'
import type { DrizzleDatabase } from '../../infrastructure/database/client.js'
import { hashPassword, timingEqualizerHash, verifyPassword } from './passwords.js'
import {
  findSessionByTokenHash,
  insertSession,
  revokeSession,
  touchSession,
} from './sessions.repository.js'
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.js'
import {
  findUserByEmail,
  findUserProfiles,
  insertUser,
  type UserRecord,
} from './users.repository.js'

/** `last_seen_at` is written at most this often, not on every request. */
const TOUCH_INTERVAL_MS = 60_000

export interface AuthContext {
  sessionId: string
  user: User
}

export interface UserProfile {
  email: string
  displayName: string
}

export interface ClientMeta {
  userAgent: string | undefined
  ip: string
}

export interface AuthServiceDeps {
  db: DrizzleDatabase
  session: SessionConfig
  now: () => Date
  /** Provided by the workspaces module (composition root), so auth never reads its tables. */
  listWorkspaces: (userId: string) => Promise<WorkspaceSummary[]>
}

export type RegisterResult =
  { ok: true; token: string; body: SessionResponse } | { ok: false; reason: 'email-taken' }

export type LoginResult =
  { ok: true; token: string; body: SessionResponse } | { ok: false; reason: 'invalid-credentials' }

export type AuthService = ReturnType<typeof createAuthService>

export function toUser(record: UserRecord): User {
  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
  }
}

export function createAuthService(deps: AuthServiceDeps) {
  const { db, session: config, now } = deps

  async function startSession(userId: string, meta: ClientMeta): Promise<string> {
    const token = generateSessionToken()
    // All session times come from the service clock, never from the database's now().
    const createdAt = now()
    await insertSession(db, {
      userId,
      tokenHash: hashSessionToken(token),
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: new Date(createdAt.getTime() + config.absoluteTimeoutMs),
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip,
    })
    return token
  }

  async function sessionBody(user: User): Promise<SessionResponse> {
    return { user, workspaces: await deps.listWorkspaces(user.id) }
  }

  return {
    sessionBody,

    /** For other modules (workspaces adds members by email). */
    async findUserIdByEmail(email: string): Promise<string | undefined> {
      return (await findUserByEmail(db, email))?.id
    },

    /** Public profile fields only: never the password hash. */
    async getProfiles(userIds: readonly string[]): Promise<Map<string, UserProfile>> {
      const rows = await findUserProfiles(db, userIds)
      return new Map(rows.map(({ id, ...profile }) => [id, profile]))
    },

    async register(input: RegisterRequest, meta: ClientMeta): Promise<RegisterResult> {
      const passwordHash = await hashPassword(input.password)
      const created = await insertUser(db, {
        email: input.email,
        displayName: input.displayName,
        passwordHash,
      })
      if (!created.ok) return { ok: false, reason: 'email-taken' }

      const user = toUser(created.user)
      return { ok: true, token: await startSession(user.id, meta), body: await sessionBody(user) }
    },

    async login(input: LoginRequest, meta: ClientMeta): Promise<LoginResult> {
      const record = await findUserByEmail(db, input.email)
      // Same argon2id cost for unknown emails, so timing does not reveal accounts.
      const valid = await verifyPassword(
        record?.passwordHash ?? (await timingEqualizerHash()),
        input.password,
      )
      if (!record || !valid) return { ok: false, reason: 'invalid-credentials' }

      const user = toUser(record)
      return { ok: true, token: await startSession(user.id, meta), body: await sessionBody(user) }
    },

    /** The session behind a cookie value, or undefined if unknown, revoked or expired. */
    async authenticate(token: string): Promise<AuthContext | undefined> {
      if (!isWellFormedSessionToken(token)) return undefined

      const row = await findSessionByTokenHash(db, hashSessionToken(token))
      if (!row) return undefined

      const current = now()
      const idleFor = current.getTime() - row.session.lastSeenAt.getTime()
      if (row.session.expiresAt <= current || idleFor >= config.idleTimeoutMs) {
        await revokeSession(db, row.session.id, current)
        return undefined
      }
      if (idleFor >= TOUCH_INTERVAL_MS) await touchSession(db, row.session.id, current)

      return { sessionId: row.session.id, user: toUser(row.user) }
    },

    async logout(sessionId: string): Promise<void> {
      await revokeSession(db, sessionId, now())
    },

    /** Revokes whatever session a cookie points to (used before issuing a new one). */
    async revokeToken(token: string): Promise<void> {
      if (!isWellFormedSessionToken(token)) return
      const row = await findSessionByTokenHash(db, hashSessionToken(token))
      if (row) await revokeSession(db, row.session.id, now())
    },
  }
}
