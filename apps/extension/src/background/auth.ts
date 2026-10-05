import {
  EXTENSION_PATHS,
  extensionTokenResponseSchema,
  type ExtensionTokenRequest,
  type ExtensionTokenResponse,
} from '@contextlayer/shared'
import type { z } from 'zod'

import { ApiUnreachableError, type ApiClient } from './api-client'
import type { AccessRecord, Vault } from './vault'

/** The connection is gone (revoked, expired, reused): the user must connect again. */
export class ConnectionEndedError extends Error {
  override readonly name = 'ConnectionEndedError'
}

/** No connection at all. */
export class NotConnectedError extends Error {
  override readonly name = 'NotConnectedError'
}

/** Refresh slightly before expiry, so a token never expires in flight. */
const EXPIRY_MARGIN_MS = 30_000

export type Auth = ReturnType<typeof createAuth>

/**
 * Access tokens for the API, with strict refresh rotation (ADR 0015):
 * - one refresh in flight per worker; concurrent callers share it;
 * - a request that gets 401 refreshes once and retries once, never more;
 * - a network failure keeps the credentials (the API may just be down);
 * - a refused refresh ends the connection and clears every credential;
 * - a refresh response is saved only if the connection it belonged to is still
 *   the current one, so a late answer cannot resurrect a disconnected session.
 */
export function createAuth(deps: {
  vault: Vault
  api: ApiClient
  now: () => number
  /** Called after the credentials of a connection were cleared because it ended. */
  onEnded: () => Promise<void>
}) {
  const { vault, api, now, onEnded } = deps
  let inflight: Promise<AccessRecord> | undefined

  async function tokenRequest(
    body: ExtensionTokenRequest,
  ): Promise<ExtensionTokenResponse | 'refused'> {
    const response = await api.request(EXTENSION_PATHS.token, { method: 'POST', body })
    if (response.status === 400 || response.status === 401) return 'refused'
    if (!response.ok)
      throw new ApiUnreachableError(`Token endpoint answered ${String(response.status)}`)
    return extensionTokenResponseSchema.parse(await response.json())
  }

  async function end(): Promise<void> {
    await vault.clearConnection(true, now())
    await onEnded()
  }

  async function doRefresh(): Promise<AccessRecord> {
    const refresh = await vault.readRefresh()
    if (!refresh) throw new NotConnectedError()
    const result = await tokenRequest({ grantType: 'refresh_token', refreshToken: refresh.token })
    // The user may have disconnected or reconnected while the request was in flight.
    const current = await vault.readRefresh()
    if (current?.token !== refresh.token) throw new ConnectionEndedError('The connection changed.')
    if (result === 'refused') {
      await end()
      throw new ConnectionEndedError('The connection was revoked or expired.')
    }
    return save(result)
  }

  async function save(tokens: ExtensionTokenResponse): Promise<AccessRecord> {
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

  function refreshOnce(): Promise<AccessRecord> {
    inflight ??= doRefresh().finally(() => {
      inflight = undefined
    })
    return inflight
  }

  async function accessToken(): Promise<string> {
    const connection = await vault.readConnection()
    if (!connection) throw new NotConnectedError()
    const access = await vault.readAccess()
    if (access?.grantId === connection.id && access.expiresAt - EXPIRY_MARGIN_MS > now()) {
      return access.token
    }
    return (await refreshOnce()).token
  }

  return {
    tokenRequest,
    save,
    accessToken,

    /** GET or POST an extension route with the access token; at most one refresh and retry. */
    async authorized<T>(
      path: string,
      schema: z.ZodType<T> | undefined,
      init: { method?: string; body?: unknown } = {},
    ): Promise<T | undefined> {
      let response = await api.request(path, { ...init, bearer: await accessToken() })
      if (response.status === 401) {
        response = await api.request(path, { ...init, bearer: (await refreshOnce()).token })
        if (response.status === 401) {
          await end()
          throw new ConnectionEndedError('The connection was revoked.')
        }
      }
      if (!response.ok) throw new ApiUnreachableError(`API answered ${String(response.status)}`)
      if (schema === undefined || response.status === 204) return undefined
      return schema.parse(await response.json())
    },
  }
}
