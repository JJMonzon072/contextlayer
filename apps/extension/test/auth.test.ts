import { EXTENSION_PATHS, type ExtensionTokenResponse } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { ApiUnreachableError } from '../src/background/api-client'
import { ConnectionEndedError, createAuth, NotConnectedError } from '../src/background/auth'
import { createVault } from '../src/background/vault'
import {
  deferred,
  dump,
  fakeApi,
  json,
  memoryStorage,
  NOW,
  tokenResponse,
  type Call,
} from './support/fakes'

/** A connection whose access token already expired, so the next use refreshes. */
async function setup(handler: (call: Call) => Response | Promise<Response>) {
  const storage = memoryStorage()
  const vault = createVault(storage)
  const { api, calls } = fakeApi(handler)
  const onEnded = vi.fn(() => Promise.resolve())
  const auth = createAuth({ vault, api, now: () => NOW, onEnded })
  const initial = tokenResponse({ accessExpiresAt: NOW - 1 })
  await auth.save(initial)
  return { storage, vault, auth, calls, onEnded, initial }
}

const tokenCalls = (calls: Call[]) => calls.filter((call) => call.path === EXTENSION_PATHS.token)

describe('extension auth', () => {
  it('reuses a valid access token without calling the API', async () => {
    const storage = memoryStorage()
    const vault = createVault(storage)
    const { api, calls } = fakeApi(() => json(500))
    const auth = createAuth({ vault, api, now: () => NOW, onEnded: () => Promise.resolve() })
    const tokens = tokenResponse()
    await auth.save(tokens)

    expect(await auth.accessToken()).toBe(tokens.accessToken)
    expect(calls).toEqual([])
  })

  it('refuses to act without a connection', async () => {
    const vault = createVault(memoryStorage())
    const { api } = fakeApi(() => json(500))
    const auth = createAuth({ vault, api, now: () => NOW, onEnded: () => Promise.resolve() })

    await expect(auth.accessToken()).rejects.toBeInstanceOf(NotConnectedError)
  })

  it('shares one refresh between concurrent callers (single flight)', async () => {
    const answer = deferred<Response>()
    const next = tokenResponse()
    const { auth, calls, initial } = await setup(() => answer.promise)

    const first = auth.accessToken()
    const second = auth.accessToken()
    answer.resolve(json(200, next))

    expect(await Promise.all([first, second])).toEqual([next.accessToken, next.accessToken])
    expect(tokenCalls(calls)).toEqual([
      {
        path: EXTENSION_PATHS.token,
        method: 'POST',
        body: { grantType: 'refresh_token', refreshToken: initial.refreshToken },
        bearer: undefined,
      },
    ])
  })

  it('retries a 401 once after refreshing, and ends the connection on a second 401', async () => {
    const { auth, calls, vault, onEnded } = await setup((call) =>
      call.path === EXTENSION_PATHS.token ? json(200, tokenResponse()) : json(401),
    )

    await expect(auth.authorized(EXTENSION_PATHS.session, undefined)).rejects.toBeInstanceOf(
      ConnectionEndedError,
    )

    // refresh (expired access), session, refresh, session: never a loop.
    expect(calls.map((call) => call.path)).toEqual([
      EXTENSION_PATHS.token,
      EXTENSION_PATHS.session,
      EXTENSION_PATHS.token,
      EXTENSION_PATHS.session,
    ])
    expect(await vault.readConnection()).toBeUndefined()
    expect(await vault.readEnded()).toMatchObject({ reason: 'ended' })
    expect(onEnded).toHaveBeenCalledOnce()
  })

  it('ends the connection when the refresh token is refused (revoked, reused, expired)', async () => {
    const { auth, storage, initial, onEnded } = await setup(() => json(401))

    await expect(auth.accessToken()).rejects.toBeInstanceOf(ConnectionEndedError)

    expect(dump(storage)).not.toContain(initial.refreshToken)
    expect(onEnded).toHaveBeenCalledOnce()
  })

  it('keeps the credentials when the API cannot be reached: a network error is not a revocation', async () => {
    for (const failure of [
      () => Promise.reject(new ApiUnreachableError('offline')),
      () => json(503),
      () => json(429),
    ]) {
      const { auth, vault, initial, onEnded } = await setup(failure)

      await expect(auth.accessToken()).rejects.toBeInstanceOf(ApiUnreachableError)

      expect((await vault.readRefresh())?.token).toBe(initial.refreshToken)
      expect(await vault.readConnection()).toBeDefined()
      expect(onEnded).not.toHaveBeenCalled()
    }
  })

  it('does not save a refresh answer that arrives after the user disconnected', async () => {
    const answer = deferred<Response>()
    const late: ExtensionTokenResponse = tokenResponse()
    const { auth, vault, storage, calls } = await setup(() => answer.promise)

    const pending = auth.accessToken()
    await vi.waitFor(() => {
      expect(tokenCalls(calls)).toHaveLength(1)
    })
    await vault.clearConnection(false, NOW)
    answer.resolve(json(200, late))

    await expect(pending).rejects.toBeInstanceOf(ConnectionEndedError)
    expect(await vault.readConnection()).toBeUndefined()
    expect(dump(storage)).not.toContain(late.refreshToken)
    expect(dump(storage)).not.toContain(late.accessToken)
  })

  it('does not let a late refresh of an old connection overwrite a new one', async () => {
    const answer = deferred<Response>()
    const { auth, vault, calls } = await setup(() => answer.promise)

    const pending = auth.accessToken()
    await vi.waitFor(() => {
      expect(tokenCalls(calls)).toHaveLength(1)
    })
    const replacement = tokenResponse({ grantId: '01a10a2e-864b-75bc-8800-aa3f01a05399' })
    await auth.save(replacement)
    answer.resolve(json(200, tokenResponse()))

    await expect(pending).rejects.toBeInstanceOf(ConnectionEndedError)
    expect((await vault.readRefresh())?.token).toBe(replacement.refreshToken)
  })
})
