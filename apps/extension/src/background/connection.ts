import {
  EXTENSION_PATHS,
  extensionExternalMessageSchema,
  type ExtensionExternalResponse,
} from '@contextlayer/shared'

import { ApiUnreachableError, type ApiClient } from './api-client'
import { ConnectionEndedError, type Auth } from './auth'
import { checkExternalSender, CONNECT_PATH, type ExternalSender } from './external'
import { randomToken, s256 } from './pkce'
import type { ConnectionRecord, Vault } from './vault'

/** How long the user has to sign in and approve in the dashboard. */
export const ATTEMPT_TTL_MS = 5 * 60_000

export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'ended'
  connection: ConnectionRecord | null
  /** A dashboard tab is open for a new connection (also while connected: switching workspace). */
  attemptPending: boolean
  /** False when the refresh token cannot be kept across browser restarts. */
  persistent: boolean
  api: 'ok' | 'unreachable'
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>

/**
 * One connection per extension profile (ADR 0015):
 * - `start` creates the PKCE attempt in session storage BEFORE opening the
 *   dashboard; the URL carries `state` and the challenge, never the verifier.
 * - `handleExternal` accepts `code` + `state` only from the dashboard tab the
 *   attempt opened, consumes the attempt, exchanges the code and only then
 *   replaces (and revokes) a previous connection. A failed attempt leaves a
 *   working connection untouched.
 */
export function createConnectionManager(deps: {
  vault: Vault
  auth: Auth
  api: ApiClient
  openTab: (url: string) => Promise<number | undefined>
  dashboardOrigin: string
  extensionId: string
  now: () => number
  /** Called whenever the active connection changed (site access reconciles). */
  onChanged: () => Promise<void>
}) {
  const { vault, auth, api, dashboardOrigin, extensionId, now, onChanged } = deps

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
      await vault.writeAttempt(attempt)
      const url = new URL(CONNECT_PATH, dashboardOrigin)
      url.searchParams.set('state', attempt.state)
      url.searchParams.set('challenge', attempt.challenge)
      const tabId = await deps.openTab(url.href)
      // Bind the attempt to its tab, unless another start replaced it meanwhile.
      if (tabId !== undefined && (await vault.readAttempt())?.id === attempt.id) {
        await vault.writeAttempt({ ...attempt, tabId })
      }
    },

    cancel: () => vault.clearAttempt(),

    /** The dashboard tab of a pending attempt was closed: the attempt is cancelled. */
    async tabClosed(tabId: number): Promise<void> {
      if ((await vault.readAttempt())?.tabId === tabId) await vault.clearAttempt()
    },

    async handleExternal(
      message: unknown,
      sender: ExternalSender,
    ): Promise<ExtensionExternalResponse> {
      const request = extensionExternalMessageSchema.safeParse(message)
      if (!request.success) return { ok: false, error: 'invalid-request' }
      const attempt = await vault.readAttempt()
      if (!attempt) return { ok: false, error: 'unknown-attempt' }
      if (checkExternalSender(sender, { dashboardOrigin, tabId: attempt.tabId }) !== undefined) {
        return { ok: false, error: 'invalid-request' }
      }
      if (request.data.state !== attempt.state) return { ok: false, error: 'unknown-attempt' }
      // Consumed now: a repeated or late message finds no attempt.
      await vault.clearAttempt()
      if (attempt.expiresAt <= now()) return { ok: false, error: 'expired-attempt' }
      if (request.data.type === 'connection.cancel') return { ok: true, connection: null }

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

      const previous = await vault.readConnection()
      const previousToken =
        previous && previous.id !== tokens.connection.id ? await currentToken() : undefined
      await auth.save(tokens)
      if (previousToken !== undefined) await revokeBestEffort(previousToken, 'replaced')
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
     * Stops local activity and forgets the credentials first, then asks the API
     * to revoke. Without a network the result says the server did not confirm.
     */
    async disconnect(): Promise<{ serverConfirmed: boolean }> {
      const token = await currentToken()
      await vault.clearConnection(false, now())
      await onChanged()
      return { serverConfirmed: await revokeBestEffort(token, 'disconnected') }
    },

    /** Checks the connection with the API when there is one. */
    async status(): Promise<ConnectionStatus> {
      const persistent = await vault.persistent()
      const attempt = await vault.readAttempt()
      const connecting = attempt !== undefined && attempt.expiresAt > now()
      let connection = await vault.readConnection()
      let api: ConnectionStatus['api'] = 'ok'
      if (connection) {
        try {
          await auth.authorized(EXTENSION_PATHS.session, undefined)
        } catch (error) {
          if (error instanceof ConnectionEndedError) connection = undefined
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
