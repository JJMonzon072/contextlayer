import {
  CONNECTION_CODE_TTL_SECONDS,
  type ConnectionCode,
  type CreateConnectionCodeRequest,
  type ExtensionConnectionInfo,
  type ExtensionTokenRequest,
  type ExtensionTokenResponse,
  type GrantRevocationReason,
  type WorkspaceRole,
} from '@contextlayer/shared'

import type { ExtensionConfig } from '../../config/env.js'
import type { DbExecutor, DrizzleDatabase } from '../../infrastructure/database/client.js'
import { generateCredential, hashCredential, isCredential, verifyPkce } from './credentials.js'
import {
  attachGrantToCode,
  consumeCode,
  findConsumedCodeGrant,
  findGrant,
  findGrantByAccessToken,
  findRefreshToken,
  findRefreshTokenById,
  insertAccessToken,
  insertCode,
  insertGrant,
  insertRefreshToken,
  lockGrant,
  markRefreshTokenUsed,
  revokeGrant,
  touchGrant,
  type GrantRow,
} from './extension.repository.js'

/**
 * Extension connections (ADR 0015). Every failure of the token endpoint is the
 * same `invalid-grant`: a client learns nothing about why a code or refresh
 * token was refused.
 */
export type ExtensionError = 'not-found' | 'invalid-grant' | 'connection-not-found'

export type Result<T> = { ok: true; value: T } | { ok: false; error: ExtensionError }

const fail = (error: ExtensionError): { ok: false; error: ExtensionError } => ({ ok: false, error })

/** What this module needs from the workspaces and auth modules (wired in app.ts). */
export interface ExtensionDirectories {
  roleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined>
  workspaceName(userId: string, workspaceId: string): Promise<string | undefined>
  profileOf(userId: string): Promise<{ displayName: string; email: string } | undefined>
}

/** The caller of an extension route, from a live access token. */
export interface ExtensionAuth {
  grantId: string
  userId: string
  workspaceId: string
  role: WorkspaceRole
}

const DEFAULT_LABEL = 'Chrome extension'

export type ExtensionService = ReturnType<typeof createExtensionService>

export function createExtensionService(deps: {
  db: DrizzleDatabase
  config: ExtensionConfig
  now: () => Date
  directories: ExtensionDirectories
}) {
  const { db, config, now, directories } = deps

  async function connectionInfo(grant: GrantRow): Promise<ExtensionConnectionInfo | undefined> {
    const [profile, workspaceName] = await Promise.all([
      directories.profileOf(grant.userId),
      directories.workspaceName(grant.userId, grant.workspaceId),
    ])
    if (!profile || workspaceName === undefined) return undefined
    return {
      id: grant.id,
      label: grant.label,
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
      user: profile,
      workspace: { id: grant.workspaceId, name: workspaceName },
    }
  }

  /** A new access token, and a refresh token that never outlives the grant. */
  async function issueTokens(
    tx: DbExecutor,
    grant: GrantRow,
    parentRefreshId: string | null,
    at: Date,
  ) {
    const accessToken = generateCredential('access')
    const refreshToken = generateCredential('refresh')
    const accessExpiresAt = new Date(
      Math.min(at.getTime() + config.accessTokenTtlMs, grant.expiresAt.getTime()),
    )
    await insertAccessToken(tx, {
      grantId: grant.id,
      tokenHash: hashCredential(accessToken),
      createdAt: at,
      expiresAt: accessExpiresAt,
    })
    await insertRefreshToken(tx, {
      grantId: grant.id,
      tokenHash: hashCredential(refreshToken),
      parentId: parentRefreshId,
      createdAt: at,
      expiresAt: grant.expiresAt,
    })
    return { accessToken, refreshToken, accessExpiresAt }
  }

  async function tokenResponse(
    grant: GrantRow,
    tokens: { accessToken: string; refreshToken: string; accessExpiresAt: Date },
  ): Promise<Result<ExtensionTokenResponse>> {
    const connection = await connectionInfo(grant)
    if (!connection) return fail('invalid-grant')
    return {
      ok: true,
      value: {
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessExpiresAt.toISOString(),
        refreshToken: tokens.refreshToken,
        connection,
      },
    }
  }

  return {
    /** Dashboard (cookie): a one-time code for one of the caller's workspaces. */
    async issueCode(
      userId: string,
      input: CreateConnectionCodeRequest,
    ): Promise<Result<ConnectionCode>> {
      if ((await directories.roleOf(input.workspaceId, userId)) === undefined) {
        return fail('not-found')
      }
      const code = generateCredential('code')
      const createdAt = now()
      const expiresAt = new Date(createdAt.getTime() + CONNECTION_CODE_TTL_SECONDS * 1000)
      await insertCode(db, {
        codeHash: hashCredential(code),
        userId,
        workspaceId: input.workspaceId,
        clientId: config.id,
        codeChallenge: input.codeChallenge,
        label: input.label ?? DEFAULT_LABEL,
        createdAt,
        expiresAt,
      })
      return { ok: true, value: { code, expiresAt: expiresAt.toISOString() } }
    },

    /**
     * Token endpoint, authorization_code: consumes the code atomically, checks
     * expiry, client, PKCE and the membership again, then creates the grant.
     * A replayed code revokes the grant it created (RFC 6749, section 4.1.2).
     */
    async exchangeCode(
      input: Extract<ExtensionTokenRequest, { grantType: 'authorization_code' }>,
    ): Promise<Result<ExtensionTokenResponse>> {
      const at = now()
      const codeHash = hashCredential(input.code)
      const outcome = await db.transaction(async (tx) => {
        const code = await consumeCode(tx, codeHash, at)
        if (!code) {
          const replayedGrant = await findConsumedCodeGrant(tx, codeHash)
          if (replayedGrant) await revokeGrant(tx, replayedGrant, 'code-replay', at)
          return undefined
        }
        if (
          code.expiresAt <= at ||
          code.clientId !== input.clientId ||
          !verifyPkce(input.codeVerifier, code.codeChallenge) ||
          (await directories.roleOf(code.workspaceId, code.userId)) === undefined
        ) {
          // The code stays consumed: a wrong verifier cannot be retried.
          return undefined
        }
        const grant = await insertGrant(tx, {
          userId: code.userId,
          workspaceId: code.workspaceId,
          clientId: code.clientId,
          label: code.label,
          createdAt: at,
          expiresAt: new Date(at.getTime() + config.grantTtlMs),
        })
        await attachGrantToCode(tx, code.id, grant.id)
        return { grant, tokens: await issueTokens(tx, grant, null, at) }
      })
      return outcome ? tokenResponse(outcome.grant, outcome.tokens) : fail('invalid-grant')
    },

    /**
     * Token endpoint, refresh_token: strict rotation with reuse detection and
     * no grace window (ADR 0015). Every refresh and revocation of a grant takes
     * its row lock, so they run one at a time: two refreshes with one token
     * leave one rotation and a revoked grant, never two live chains, and a
     * late refresh cannot undo a revocation. The new refresh token keeps the
     * grant's expiry: rotating never extends the 30-day limit.
     */
    async refresh(
      input: Extract<ExtensionTokenRequest, { grantType: 'refresh_token' }>,
    ): Promise<Result<ExtensionTokenResponse>> {
      const at = now()
      const outcome = await db.transaction(async (tx) => {
        const presented = await findRefreshToken(tx, hashCredential(input.refreshToken))
        if (!presented) return undefined
        const grant = await lockGrant(tx, presented.grantId)
        if (grant?.revokedAt !== null || grant.expiresAt <= at) return undefined
        // Read again under the lock: a concurrent refresh may have just used it.
        const token = await findRefreshTokenById(tx, presented.id)
        if (!token) return undefined
        if (token.usedAt !== null) {
          // Reuse: someone else holds a token from this chain. The revocation is
          // committed: this callback returns normally instead of throwing.
          await revokeGrant(tx, grant.id, 'refresh-reuse', at)
          return undefined
        }
        if (token.expiresAt <= at) return undefined
        if ((await directories.roleOf(grant.workspaceId, grant.userId)) === undefined) {
          return undefined
        }
        await markRefreshTokenUsed(tx, token.id, at)
        await touchGrant(tx, grant.id, at)
        return { grant, tokens: await issueTokens(tx, grant, token.id, at) }
      })
      return outcome ? tokenResponse(outcome.grant, outcome.tokens) : fail('invalid-grant')
    },

    /** Revokes a grant under its lock, so no refresh can complete after it. */
    async revoke(grantId: string, reason: GrantRevocationReason): Promise<void> {
      const at = now()
      await db.transaction(async (tx) => {
        if (await lockGrant(tx, grantId)) await revokeGrant(tx, grantId, reason, at)
      })
    },

    /**
     * Extension routes (bearer): the token must be live, its grant unrevoked
     * and unexpired, and the user still a member of the grant's workspace.
     */
    async authenticate(accessToken: string): Promise<ExtensionAuth | undefined> {
      if (!isCredential('access', accessToken)) return undefined
      const at = now()
      const grant = await findGrantByAccessToken(db, hashCredential(accessToken), at)
      if (!grant) return undefined
      const role = await directories.roleOf(grant.workspaceId, grant.userId)
      if (role === undefined) return undefined
      await touchGrant(db, grant.id, at)
      return { grantId: grant.id, userId: grant.userId, workspaceId: grant.workspaceId, role }
    },

    async session(auth: ExtensionAuth): Promise<ExtensionConnectionInfo | undefined> {
      const grant = await findGrant(db, auth.grantId)
      return grant ? connectionInfo(grant) : undefined
    },
  }
}
