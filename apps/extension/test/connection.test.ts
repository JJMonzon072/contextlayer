import { DEVELOPMENT_EXTENSION_ID, EXTENSION_PATHS } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { ApiUnreachableError } from '../src/background/api-client'
import { createAuth } from '../src/background/auth'
import { ATTEMPT_TTL_MS, createConnectionManager } from '../src/background/connection'
import { CONNECT_PATH, type ExternalSender } from '../src/background/external'
import { s256 } from '../src/background/pkce'
import { createVault } from '../src/background/vault'
import {
  dump,
  fakeApi,
  GRANT_A,
  GRANT_B,
  json,
  memoryStorage,
  NOW,
  tokenResponse,
  type Call,
} from './support/fakes'

const DASHBOARD = 'http://localhost:5173'
const TAB = 42
const CODE = `clc_${'c'.repeat(43)}`

function setup(
  handler: (call: Call) => Response | Promise<Response> = () => json(204),
  apiAccess = true,
) {
  let clock = NOW
  const storage = memoryStorage()
  const vault = createVault(storage)
  const { api, calls } = fakeApi(handler)
  const onChanged = vi.fn(() => Promise.resolve())
  const auth = createAuth({ vault, api, now: () => clock, onEnded: onChanged })
  const openTab = vi.fn<(url: string) => Promise<number | undefined>>(() => Promise.resolve(TAB))
  const manager = createConnectionManager({
    vault,
    auth,
    api,
    openTab,
    apiAccess: () => Promise.resolve(apiAccess),
    dashboardOrigin: DASHBOARD,
    extensionId: DEVELOPMENT_EXTENSION_ID,
    now: () => clock,
    onChanged,
  })
  const tick = (ms: number) => (clock += ms)
  return { storage, vault, auth, manager, calls, openTab, onChanged, tick }
}

/** What Chrome reports for the dashboard tab the attempt opened. */
function dashboardSender(overrides: Partial<ExternalSender> = {}): ExternalSender {
  return {
    origin: DASHBOARD,
    url: `${DASHBOARD}${CONNECT_PATH}?state=x&challenge=y`,
    frameId: 0,
    documentLifecycle: 'active',
    tab: { id: TAB } as chrome.tabs.Tab,
    ...overrides,
  }
}

async function startedState(vault: ReturnType<typeof createVault>) {
  const attempt = await vault.readAttempt()
  if (!attempt) throw new Error('no attempt')
  return attempt
}

const tokenCalls = (calls: Call[]) => calls.filter((call) => call.path === EXTENSION_PATHS.token)

describe('connection manager', () => {
  it('stores the attempt before opening the dashboard, with the challenge but never the verifier in the URL', async () => {
    const { manager, vault, openTab } = setup()
    openTab.mockImplementation(async () => {
      // The attempt must exist before the page can answer.
      expect(await vault.readAttempt()).toBeDefined()
      return TAB
    })

    await manager.start()

    const attempt = await startedState(vault)
    const url = new URL(openTab.mock.calls[0]?.[0] ?? '')
    expect(url.origin + url.pathname).toBe(`${DASHBOARD}${CONNECT_PATH}`)
    expect(url.searchParams.get('state')).toBe(attempt.state)
    expect(url.searchParams.get('challenge')).toBe(await s256(attempt.verifier))
    expect(url.href).not.toContain(attempt.verifier)
    expect(attempt).toMatchObject({ tabId: TAB, expiresAt: NOW + ATTEMPT_TTL_MS })
  })

  it('exchanges the code with the verifier and answers the dashboard without any token', async () => {
    const tokens = tokenResponse()
    const { manager, vault, calls, onChanged, storage } = setup((call) =>
      call.path === EXTENSION_PATHS.token ? json(200, tokens) : json(204),
    )
    await manager.start()
    const attempt = await startedState(vault)

    const answer = await manager.handleExternal(
      { type: 'connection.complete', state: attempt.state, code: CODE },
      dashboardSender(),
    )

    expect(answer).toEqual({
      ok: true,
      connection: { user: { displayName: 'Alice' }, workspace: { name: 'Acme' } },
    })
    expect(JSON.stringify(answer)).not.toMatch(/cla_|clr_|clc_/)
    expect(tokenCalls(calls)[0]?.body).toEqual({
      grantType: 'authorization_code',
      code: CODE,
      codeVerifier: attempt.verifier,
      clientId: DEVELOPMENT_EXTENSION_ID,
    })
    expect(await vault.readAttempt()).toBeUndefined()
    expect((await vault.readConnection())?.id).toBe(GRANT_A)
    // The refresh token lives in the restricted local area, the access token in session.
    expect(JSON.stringify([...storage.local.data])).toContain(tokens.refreshToken)
    expect(JSON.stringify([...storage.session.data])).toContain(tokens.accessToken)
    expect(JSON.stringify([...storage.local.data])).not.toContain(tokens.accessToken)
    expect(onChanged).toHaveBeenCalled()
  })

  it('accepts each attempt once: a replayed message changes nothing', async () => {
    const { manager, vault, calls } = setup((call) =>
      call.path === EXTENSION_PATHS.token ? json(200, tokenResponse()) : json(204),
    )
    await manager.start()
    const message = {
      type: 'connection.complete',
      state: (await startedState(vault)).state,
      code: CODE,
    }

    await manager.handleExternal(message, dashboardSender())
    const replay = await manager.handleExternal(message, dashboardSender())

    expect(replay).toEqual({ ok: false, error: 'unknown-attempt' })
    expect(tokenCalls(calls)).toHaveLength(1)
  })

  it('ignores a wrong state without consuming the real attempt', async () => {
    const { manager, vault, calls } = setup((call) =>
      call.path === EXTENSION_PATHS.token ? json(200, tokenResponse()) : json(204),
    )
    await manager.start()
    const attempt = await startedState(vault)

    const forged = await manager.handleExternal(
      { type: 'connection.complete', state: 'f'.repeat(43), code: CODE },
      dashboardSender(),
    )
    expect(forged).toEqual({ ok: false, error: 'unknown-attempt' })
    expect(tokenCalls(calls)).toHaveLength(0)

    const real = await manager.handleExternal(
      { type: 'connection.complete', state: attempt.state, code: CODE },
      dashboardSender(),
    )
    expect(real.ok).toBe(true)
  })

  it('refuses senders other than the top frame of the dashboard tab it opened', async () => {
    const { manager, vault, calls } = setup()
    await manager.start()
    const message = {
      type: 'connection.complete',
      state: (await startedState(vault)).state,
      code: CODE,
    }

    for (const sender of [
      dashboardSender({ origin: 'http://localhost:5174' }),
      dashboardSender({ frameId: 3 }),
      dashboardSender({ tab: { id: TAB + 1 } as chrome.tabs.Tab }),
      dashboardSender({ url: `${DASHBOARD}/workspaces` }),
      dashboardSender({ id: 'abcdefghijklmnopabcdefghijklmnop' }),
      dashboardSender({ documentLifecycle: 'prerender' }),
    ]) {
      expect(await manager.handleExternal(message, sender)).toEqual({
        ok: false,
        error: 'invalid-request',
      })
    }
    expect(tokenCalls(calls)).toHaveLength(0)
    expect(await vault.readAttempt()).toBeDefined()
  })

  it('refuses malformed messages and messages without a pending attempt', async () => {
    const { manager, vault } = setup()

    expect(
      await manager.handleExternal(
        { type: 'connection.complete', state: 's'.repeat(43), code: CODE },
        dashboardSender(),
      ),
    ).toEqual({ ok: false, error: 'unknown-attempt' })

    await manager.start()
    const state = (await startedState(vault)).state
    for (const message of [
      null,
      'connect',
      { type: 'connection.complete', state, code: 'not-a-code' },
      { type: 'connection.complete', state, code: CODE, workspaceId: 'x' },
      { type: 'api.request', path: '/v1/extension/session' },
    ]) {
      expect(await manager.handleExternal(message, dashboardSender())).toEqual({
        ok: false,
        error: 'invalid-request',
      })
    }
  })

  it('expires an attempt after five minutes', async () => {
    const { manager, vault, calls, tick } = setup()
    await manager.start()
    const state = (await startedState(vault)).state
    tick(ATTEMPT_TTL_MS)

    expect(
      await manager.handleExternal(
        { type: 'connection.complete', state, code: CODE },
        dashboardSender(),
      ),
    ).toEqual({ ok: false, error: 'expired-attempt' })
    expect(tokenCalls(calls)).toHaveLength(0)
  })

  it('keeps a working connection when a new attempt fails', async () => {
    for (const [failure, error] of [
      [() => json(400, { error: { code: 'BAD_REQUEST' } }), 'exchange-failed'],
      [() => Promise.reject(new ApiUnreachableError('offline')), 'api-unreachable'],
    ] as const) {
      const existing = tokenResponse()
      const { manager, vault, auth, calls } = setup((call) =>
        call.path === EXTENSION_PATHS.token ? failure() : json(204),
      )
      await auth.save(existing)
      await manager.start()

      const answer = await manager.handleExternal(
        { type: 'connection.complete', state: (await startedState(vault)).state, code: CODE },
        dashboardSender(),
      )

      expect(answer).toEqual({ ok: false, error })
      expect((await vault.readRefresh())?.token).toBe(existing.refreshToken)
      expect(calls.filter((call) => call.path === EXTENSION_PATHS.revoke)).toHaveLength(0)
    }
  })

  it('switching workspace replaces the connection and revokes the previous grant', async () => {
    const previous = tokenResponse({ grantId: GRANT_A, workspace: 'Acme' })
    const next = tokenResponse({ grantId: GRANT_B, workspace: 'Globex' })
    const { manager, vault, auth, calls, storage } = setup((call) =>
      call.path === EXTENSION_PATHS.token ? json(200, next) : json(204),
    )
    await auth.save(previous)
    await manager.start()

    await manager.handleExternal(
      { type: 'connection.complete', state: (await startedState(vault)).state, code: CODE },
      dashboardSender(),
    )

    expect((await vault.readConnection())?.workspace.name).toBe('Globex')
    expect(calls.find((call) => call.path === EXTENSION_PATHS.revoke)).toEqual({
      path: EXTENSION_PATHS.revoke,
      method: 'POST',
      body: { reason: 'replaced' },
      bearer: previous.accessToken,
    })
    expect(dump(storage)).not.toContain(previous.refreshToken)
  })

  it('cancels from the dashboard, from the popup and when the dashboard tab closes', async () => {
    const { manager, vault, calls } = setup()

    await manager.start()
    expect(
      await manager.handleExternal(
        { type: 'connection.cancel', state: (await startedState(vault)).state },
        dashboardSender(),
      ),
    ).toEqual({ ok: true, connection: null })
    expect(await vault.readAttempt()).toBeUndefined()

    await manager.start()
    await manager.cancel()
    expect(await vault.readAttempt()).toBeUndefined()

    await manager.start()
    await manager.tabClosed(TAB + 1)
    expect(await vault.readAttempt()).toBeDefined()
    await manager.tabClosed(TAB)
    expect(await vault.readAttempt()).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('disconnects locally first and reports whether the server confirmed the revocation', async () => {
    for (const [revoke, serverConfirmed] of [
      [() => json(204), true],
      [() => Promise.reject(new ApiUnreachableError('offline')), false],
    ] as const) {
      const tokens = tokenResponse()
      const { manager, auth, calls, storage, vault } = setup(revoke)
      await auth.save(tokens)

      expect(await manager.disconnect()).toEqual({ serverConfirmed })
      expect(calls).toEqual([
        {
          path: EXTENSION_PATHS.revoke,
          method: 'POST',
          body: { reason: 'disconnected' },
          bearer: tokens.accessToken,
        },
      ])
      expect(dump(storage)).not.toContain(tokens.refreshToken)
      expect(await vault.readEnded()).toBeUndefined()
    }
  })

  it('reports the status from a live session check', async () => {
    const tokens = tokenResponse()
    let session: () => Response | Promise<Response> = () => json(200, {})
    const { manager, auth, vault } = setup((call) =>
      call.path === EXTENSION_PATHS.session ? session() : json(401),
    )

    expect(await manager.status()).toMatchObject({ state: 'disconnected', connection: null })

    await manager.start()
    expect(await manager.status()).toMatchObject({ state: 'connecting', attemptPending: true })
    await manager.cancel()

    await auth.save(tokens)
    expect(await manager.status()).toMatchObject({
      state: 'connected',
      api: 'ok',
      persistent: true,
      connection: { workspace: { name: 'Acme' } },
    })
    expect(JSON.stringify(await manager.status())).not.toMatch(/cla_|clr_/)

    session = () => Promise.reject(new ApiUnreachableError('offline'))
    expect(await manager.status()).toMatchObject({ state: 'connected', api: 'unreachable' })

    // Revoked from the dashboard: 401, refresh refused, connection over.
    session = () => json(401)
    expect(await manager.status()).toMatchObject({ state: 'ended', connection: null })
    expect(await vault.readRefresh()).toBeUndefined()
  })

  it('keeps credentials in session storage only when local storage cannot be restricted', async () => {
    const storage = memoryStorage(false)
    const vault = createVault(storage)
    const { api } = fakeApi(() => json(204))
    const auth = createAuth({ vault, api, now: () => NOW, onEnded: () => Promise.resolve() })
    const tokens = tokenResponse()

    await auth.save(tokens)

    expect(storage.local.data.size).toBe(0)
    expect(JSON.stringify([...storage.session.data])).toContain(tokens.refreshToken)
    expect(await vault.persistent()).toBe(false)
  })
})
