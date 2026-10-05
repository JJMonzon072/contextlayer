import {
  EXTENSION_PATHS,
  extensionExternalMessageSchema,
  type ExtensionExternalResponse,
} from '@contextlayer/shared'

import { ApiUnreachableError, type ApiClient } from './api-client'
import {
  ConnectionChangedError,
  ConnectionEndedError,
  EXPIRY_MARGIN_MS,
  storeTokens,
  type Auth,
} from './auth'
import { checkExternalSender, CONNECT_PATH, type ExternalSender } from './external'
import type { Lifecycle } from './lifecycle'
import { randomToken, s256 } from './pkce'
import type { AccessRecord, Attempt, ConnectionRecord, RefreshRecord, Vault } from './vault'

/** How long the user has to sign in and approve in the dashboard. */
export const ATTEMPT_TTL_MS = 5 * 60_000

export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'ended'
  connection: ConnectionRecord | null
  /** A dashboard tab is open for a new connection (also while connected: switching workspace). */
  attemptPending: boolean
  /** False when the refresh token cannot be kept across browser restarts. */
  persistent: boolean
  api: 'ok' | 'unreachable' | 'withheld'
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>

/**
 * One connection per extension profile (ADR 0015):
 * - `start` creates the PKCE attempt in session storage BEFORE opening the
 *   dashboard; the URL carries `state` and the challenge, never the verifier.
 * - `handleExternal` accepts `code` + `state` only from the dashboard tab the
 *   attempt opened, and takes the attempt inside a life-cycle transition, so
 *   two simultaneous messages exchange the code once. The exchange itself runs
 *   outside the lock; its result is installed only if nothing happened in
 *   between (Cancel, Disconnect, a newer attempt, the tab closed). Otherwise
 *   the grant the server just created is revoked, best effort, and never
 *   installed. A failed attempt leaves a working connection untouched.
 * - `disconnect` forgets everything locally at once and only then talks to
 *   the API.
 */
export function createConnectionManager(deps: {
  vault: Vault
  auth: Auth
  api: ApiClient
  lifecycle: Lifecycle
  openTab: (url: string) => Promise<number | undefined>
  /** False when the user withheld the extension's access to the API origin in Chrome. */
  apiAccess: () => Promise<boolean>
  dashboardOrigin: string
  extensionId: string
  now: () => number
  /** Called whenever the active connection changed (site access reconciles). */
  onChanged: () => Promise<void>
}) {
  const { vault, auth, api, lifecycle, dashboardOrigin, extensionId, now, onChanged } = deps
  /** The code exchange in flight, if any: closing its dashboard tab abandons it. */
  let exchange: { tabId: number | null } | undefined

  async function revokeBestEffort(token: string | undefined, reason: 'disconnected' | 'replaced') {
    if (token === undefined) return false
    try {
      const response = await api.request(EXTENSION_PATHS.revoke, {
        method: 'POST',
        bearer: token,
        body: { reason },
      })
      return response.status === 204
    } catch {
      return false
    }
  }

  async function currentToken(): Promise<string | undefined> {
    try {
      return await auth.accessToken()
    } catch {
      return undefined
    }
  }

  /**
   * Revokes a connection that is no longer stored, from the credentials it had.
   * An expired access token is first exchanged with the refresh token, whose
   * answer is used for this call only and never stored.
   */
  async function revokeForgotten(forgotten: {
    connection: ConnectionRecord | undefined
    access: AccessRecord | undefined
    refresh: RefreshRecord | undefined
  }): Promise<boolean> {
    const { connection, access, refresh } = forgotten
    if (!connection) return false
    let token =
      access?.grantId === connection.id && access.expiresAt - EXPIRY_MARGIN_MS > now()
        ? access.token
        : undefined
    if (token === undefined && refresh?.grantId === connection.id) {
      try {
        const tokens = await auth.tokenRequest({
          grantType: 'refresh_token',
          refreshToken: refresh.token,
        })
        if (tokens !== 'refused') token = tokens.accessToken
      } catch {
        return false
      }
    }
    return revokeBestEffort(token, 'disconnected')
  }

  return {
    async start(): Promise<void> {
      await vault.ready()
      const verifier = randomToken()
      const createdAt = now()
      const attempt = {
        id: randomToken(),
        state: randomToken(),
        verifier,
        challenge: await s256(verifier),
        createdAt,
        expiresAt: createdAt + ATTEMPT_TTL_MS,
        tabId: null,
      }
      // A new attempt supersedes any earlier one and its exchange in flight.
      await lifecycle.exclusive(async () => {
        lifecycle.invalidateAttempts()
        exchange = undefined
        await vault.writeAttempt(attempt)
      })
      const url = new URL(CONNECT_PATH, dashboardOrigin)
      url.searchParams.set('state', attempt.state)
      url.searchParams.set('challenge', attempt.challenge)
      const tabId = await deps.openTab(url.href)
      // Bind the attempt to its tab, unless another start replaced it meanwhile.
      if (tabId !== undefined) {
        await lifecycle.exclusive(async () => {
          if ((await vault.readAttempt())?.id === attempt.id) {
            await vault.writeAttempt({ ...attempt, tabId })
          }
        })
      }
    },

    /** Cancels the pending attempt and the code exchange it may have in flight. */
    cancel: (): Promise<void> =>
      lifecycle.exclusive(async () => {
        lifecycle.invalidateAttempts()
        exchange = undefined
        await vault.clearAttempt()
      }),

    /** The dashboard tab of a pending attempt (or exchange) was closed: it is cancelled. */
    tabClosed: (tabId: number): Promise<void> =>
      lifecycle.exclusive(async () => {
        if ((await vault.readAttempt())?.tabId === tabId) {
          lifecycle.invalidateAttempts()
          await vault.clearAttempt()
        }
        if (exchange?.tabId === tabId) {
          lifecycle.invalidateAttempts()
          exchange = undefined
        }
      }),

    async handleExternal(
      message: unknown,
      sender: ExternalSender,
    ): Promise<ExtensionExternalResponse> {
      const request = extensionExternalMessageSchema.safeParse(message)
      if (!request.success) return { ok: false, error: 'invalid-request' }

      // Taken in one transition: of two simultaneous messages, one finds the
      // attempt and the other finds nothing.
      type Claim =
        | { error: 'unknown-attempt' | 'invalid-request' | 'expired-attempt'; attempt?: never }
        | { error?: never; attempt?: Attempt; generation: number }
      const claim = await lifecycle.exclusive(async (): Promise<Claim> => {
        const attempt = await vault.readAttempt()
        if (!attempt) return { error: 'unknown-attempt' }
        if (checkExternalSender(sender, { dashboardOrigin, tabId: attempt.tabId }) !== undefined) {
          return { error: 'invalid-request' }
        }
        if (request.data.state !== attempt.state) return { error: 'unknown-attempt' }
        // Consumed now: a repeated or late message finds no attempt.
        await vault.clearAttempt()
        lifecycle.invalidateAttempts()
        if (attempt.expiresAt <= now()) return { error: 'expired-attempt' }
        // A cancel from the dashboard: the attempt is gone, nothing to exchange.
        if (request.data.type === 'connection.cancel') return { generation: 0 }
        exchange = { tabId: attempt.tabId }
        return { attempt, generation: lifecycle.attemptGeneration() }
      })
      if (claim.error !== undefined) return { ok: false, error: claim.error }
      const { attempt, generation } = claim
      if (attempt === undefined || request.data.type !== 'connection.complete') {
        return { ok: true, connection: null }
      }

      await vault.ready()
      let tokens
      try {
        tokens = await auth.tokenRequest({
          grantType: 'authorization_code',
          code: request.data.code,
          codeVerifier: attempt.verifier,
          clientId: extensionId,
        })
      } catch (error) {
        if (error instanceof ApiUnreachableError) return { ok: false, error: 'api-unreachable' }
        throw error
      }
      if (tokens === 'refused') return { ok: false, error: 'exchange-failed' }

      // The connection being replaced, to revoke it afterwards (may refresh it).
      const previousToken = await currentToken()
      const replaced = await lifecycle.exclusive(async () => {
        if (lifecycle.attemptGeneration() !== generation) return 'stale' as const
        const previous = await vault.readConnection()
        lifecycle.invalidateAttempts()
        lifecycle.invalidateCredentials()
        exchange = undefined
        await storeTokens(vault, tokens)
        return previous
      })
      if (replaced === 'stale') {
        // Cancelled, disconnected or superseded meanwhile: the server created a
        // grant nobody wants. It is never installed, and revoked if possible.
        await revokeBestEffort(tokens.accessToken, 'disconnected')
        return { ok: false, error: 'unknown-attempt' }
      }
      if (replaced && replaced.id !== tokens.connection.id) {
        await revokeBestEffort(previousToken, 'replaced')
      }
      await onChanged()
      return {
        ok: true,
        connection: {
          user: { displayName: tokens.connection.user.displayName },
          workspace: { name: tokens.connection.workspace.name },
        },
      }
    },

    /**
     * Forgets the credentials, the attempt and any exchange in flight at once,
     * without waiting for the network, then asks the API to revoke. Without a
     * network the result says the server did not confirm.
     */
    async disconnect(): Promise<{ serverConfirmed: boolean }> {
      const forgotten = await lifecycle.exclusive(async () => {
        const snapshot = {
          connection: await vault.readConnection(),
          access: await vault.readAccess(),
          refresh: await vault.readRefresh(),
        }
        lifecycle.invalidateAttempts()
        lifecycle.invalidateCredentials()
        exchange = undefined
        await vault.clearAttempt()
        await vault.clearConnection(false, now())
        return snapshot
      })
      await onChanged()
      return { serverConfirmed: await revokeForgotten(forgotten) }
    },

    /** Checks the connection with the API when there is one. */
    async status(): Promise<ConnectionStatus> {
      const persistent = await vault.persistent()
      const attempt = await vault.readAttempt()
      const connecting = attempt !== undefined && attempt.expiresAt > now()
      let connection = await vault.readConnection()
      let api: ConnectionStatus['api'] = (await deps.apiAccess()) ? 'ok' : 'withheld'
      if (connection && api === 'ok') {
        try {
          await auth.authorized(EXTENSION_PATHS.session, undefined)
        } catch (error) {
          // Replaced or disconnected meanwhile: report what is stored now.
          if (error instanceof ConnectionChangedError) connection = await vault.readConnection()
          else if (error instanceof ConnectionEndedError) connection = undefined
          else if (error instanceof ApiUnreachableError) api = 'unreachable'
          else throw error
        }
      }
      const ended = connection === undefined && (await vault.readEnded()) !== undefined
      return {
        state: connection
          ? 'connected'
          : connecting
            ? 'connecting'
            : ended
              ? 'ended'
              : 'disconnected',
        connection: connection ?? null,
        attemptPending: connecting,
        persistent,
        api,
      }
    },
  }
}
