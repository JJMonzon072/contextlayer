import {
  apiErrorSchema,
  EXTENSION_PATHS,
  extensionTokenResponseSchema,
  type ExtensionTokenRequest,
  type ExtensionTokenResponse,
} from '@contextlayer/shared'
import type { z } from 'zod'

import { ApiStatusError, ApiUnreachableError, type ApiClient } from './api-client'
import type { Lifecycle } from './lifecycle'
import type { AccessRecord, Vault } from './vault'

/** The connection is gone (revoked, expired, reused): the user must connect again. */
export class ConnectionEndedError extends Error {
  override readonly name: string = 'ConnectionEndedError'
}

/**
 * The connection a request started with was replaced or disconnected while it
 * was in flight. Nothing was cleared: the current connection, if any, is fine.
 */
export class ConnectionChangedError extends ConnectionEndedError {
  override readonly name = 'ConnectionChangedError'
}

/** No connection at all. */
export class NotConnectedError extends Error {
  override readonly name = 'NotConnectedError'
}

/** Refresh slightly before expiry, so a token never expires in flight. */
export const EXPIRY_MARGIN_MS = 30_000

export type Auth = ReturnType<typeof createAuth>

/** Writes a token response as the stored connection. Callers hold the life-cycle lock. */
export async function storeTokens(
  vault: Vault,
  tokens: ExtensionTokenResponse,
): Promise<AccessRecord> {
  const access = {
    grantId: tokens.connection.id,
    token: tokens.accessToken,
    expiresAt: Date.parse(tokens.accessTokenExpiresAt),
  }
  await vault.saveConnection({
    access,
    refresh: { grantId: tokens.connection.id, token: tokens.refreshToken },
    connection: tokens.connection,
  })
  return access
}

/**
 * Access tokens for the API, with strict refresh rotation (ADR 0015):
 * - one refresh in flight per connection; concurrent callers of the same
 *   connection share it, a newer connection never waits for an older one's;
 * - a request that gets 401 refreshes once and retries once, never more;
 * - a network failure keeps the credentials (the API may just be down);
 * - a refused refresh ends the connection and clears every credential;
 * - every result is applied inside a life-cycle transition, and only if the
 *   connection is still the one the request started with: a late answer can
 *   neither bring back a disconnected connection nor overwrite or clear a newer
 *   one.
 */
export function createAuth(deps: {
  vault: Vault
  api: ApiClient
  lifecycle: Lifecycle
  now: () => number
  /** Called after the credentials of a connection were cleared because it ended. */
  onEnded: () => Promise<void>
}) {
  const { vault, api, lifecycle, now, onEnded } = deps
  let inflight: { generation: number; promise: Promise<AccessRecord> } | undefined

  async function tokenRequest(
    body: ExtensionTokenRequest,
  ): Promise<ExtensionTokenResponse | 'refused'> {
    const response = await api.request(EXTENSION_PATHS.token, { method: 'POST', body })
    if (response.status === 400 || response.status === 401) return 'refused'
    if (!response.ok)
      throw new ApiUnreachableError(`Token endpoint answered ${String(response.status)}`)
    return extensionTokenResponseSchema.parse(await response.json())
  }

  /** Ends the connection of `generation` if it is still the stored one. */
  async function endIfCurrent(generation: number): Promise<void> {
    const ended = await lifecycle.exclusive(async () => {
      if (lifecycle.credentialGeneration() !== generation) return false
      lifecycle.invalidateCredentials()
      await vault.clearConnection(true, now())
      return true
    })
    if (!ended) throw new ConnectionChangedError('The connection changed during the request.')
    await onEnded()
  }

  async function doRefresh(generation: number): Promise<AccessRecord> {
    const refresh = await lifecycle.exclusive(async () =>
      lifecycle.credentialGeneration() === generation ? await vault.readRefresh() : 'changed',
    )
    if (refresh === 'changed') throw new ConnectionChangedError('The connection changed.')
    if (!refresh) throw new NotConnectedError()
    const result = await tokenRequest({ grantType: 'refresh_token', refreshToken: refresh.token })
    const outcome = await lifecycle.exclusive(async () => {
      // The user may have disconnected or reconnected while the request was in flight.
      if (lifecycle.credentialGeneration() !== generation) return 'changed' as const
      // Defense in depth: the stored token must still be the one just rotated.
      if ((await vault.readRefresh())?.token !== refresh.token) return 'changed' as const
      if (result === 'refused') {
        lifecycle.invalidateCredentials()
        await vault.clearConnection(true, now())
        return 'ended' as const
      }
      return storeTokens(vault, result)
    })
    if (outcome === 'changed') throw new ConnectionChangedError('The connection changed.')
    if (outcome === 'ended') {
      await onEnded()
      throw new ConnectionEndedError('The connection was revoked or expired.')
    }
    return outcome
  }

  function refreshOnce(generation: number): Promise<AccessRecord> {
    if (inflight?.generation === generation) return inflight.promise
    const promise = doRefresh(generation).finally(() => {
      if (inflight?.promise === promise) inflight = undefined
    })
    inflight = { generation, promise }
    return promise
  }

  /** A usable access token and the generation of the connection it belongs to. */
  async function credential(): Promise<{ token: string; generation: number }> {
    const snapshot = await lifecycle.exclusive(async () => ({
      generation: lifecycle.credentialGeneration(),
      connection: await vault.readConnection(),
      access: await vault.readAccess(),
    }))
    const { generation, connection, access } = snapshot
    if (!connection) throw new NotConnectedError()
    if (access?.grantId === connection.id && access.expiresAt - EXPIRY_MARGIN_MS > now()) {
      return { token: access.token, generation }
    }
    return { token: (await refreshOnce(generation)).token, generation }
  }

  return {
    tokenRequest,

    /** Installs a new connection (outside the code exchange: tests and tooling). */
    save: (tokens: ExtensionTokenResponse): Promise<AccessRecord> =>
      lifecycle.exclusive(async () => {
        lifecycle.invalidateCredentials()
        return storeTokens(vault, tokens)
      }),

    accessToken: async (): Promise<string> => (await credential()).token,

    /** GET or POST an extension route with the access token; at most one refresh and retry. */
    async authorized<T>(
      path: string,
      schema: z.ZodType<T> | undefined,
      init: { method?: string; body?: unknown } = {},
    ): Promise<T | undefined> {
      const first = await credential()
      let response = await api.request(path, { ...init, bearer: first.token })
      if (response.status === 401) {
        const fresh = await refreshOnce(first.generation)
        response = await api.request(path, { ...init, bearer: fresh.token })
        if (response.status === 401) {
          await endIfCurrent(first.generation)
          throw new ConnectionEndedError('The connection was revoked.')
        }
      }
      if (!response.ok) {
        const body = apiErrorSchema.safeParse(await response.json().catch(() => undefined))
        throw new ApiStatusError(
          response.status,
          body.success ? body.data.error.code : undefined,
          body.success ? body.data.error.message : `API answered ${String(response.status)}`,
        )
      }
      if (schema === undefined || response.status === 204) return undefined
      return schema.parse(await response.json())
    },
  }
}
