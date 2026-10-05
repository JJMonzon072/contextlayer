import { DEVELOPMENT_EXTENSION_ID, EXTENSION_PATHS } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { ConnectionEndedError } from '../src/background/auth'
import { CONNECT_PATH, type ExternalSender } from '../src/background/external'
import { createWorkerCore } from '../src/background/core'
import {
  deferred,
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

/**
 * Races between the connection's life cycle and answers that arrive late.
 * Every network answer is a promise the test resolves when it chooses, so the
 * interleavings are deterministic; no test sleeps.
 */

const DASHBOARD = 'http://localhost:5173'
const TAB = 42
const CODE_B = `clc_${'b'.repeat(43)}`
const CODE_C = `clc_${'c'.repeat(43)}`
const GRANT_C = '01a10a2e-864b-75bc-8800-aa3f01a05362'

type Responder = (call: Call) => Response | Promise<Response>

function harness() {
  const storage = memoryStorage()
  let responder: Responder = () => json(204)
  const { api, calls } = fakeApi((call) => responder(call))
  const onChanged = vi.fn(() => Promise.resolve())
  const core = createWorkerCore({
    storage,
    api,
    now: () => NOW,
    openTab: () => Promise.resolve(TAB),
    apiAccess: () => Promise.resolve(true),
    dashboardOrigin: DASHBOARD,
    extensionId: DEVELOPMENT_EXTENSION_ID,
    onChanged,
  })
  return {
    storage,
    calls,
    onChanged,
    ...core,
    respond: (next: Responder) => {
      responder = next
    },
  }
}

const sender: ExternalSender = {
  origin: DASHBOARD,
  url: `${DASHBOARD}${CONNECT_PATH}?state=x&challenge=y`,
  frameId: 0,
  documentLifecycle: 'active',
  tab: { id: TAB } as chrome.tabs.Tab,
}

async function pendingAttempt(context: ReturnType<typeof harness>) {
  await context.connection.start()
  const attempt = await context.vault.readAttempt()
  if (!attempt) throw new Error('no attempt')
  return attempt
}

/** Lets every pending promise chain run as far as it can (one macrotask, no sleep). */
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

const complete = (state: string, code = CODE_B) => ({ type: 'connection.complete', state, code })
const isToken = (call: Call) => call.path === EXTENSION_PATHS.token
const tokenCalls = (calls: Call[]) => calls.filter(isToken)
const revokes = (calls: Call[]) => calls.filter((call) => call.path === EXTENSION_PATHS.revoke)

describe('a pending code exchange loses to the user', () => {
  it('Disconnect: stays disconnected, the late tokens are never stored, the orphan grant is revoked', async () => {
    const context = harness()
    const a = tokenResponse({ grantId: GRANT_A })
    await context.auth.save(a)
    const b = tokenResponse({ grantId: GRANT_B, workspace: 'Globex' })
    const exchange = deferred<Response>()
    context.respond((call) => (isToken(call) ? exchange.promise : json(204)))
    const attempt = await pendingAttempt(context)

    const answer = context.connection.handleExternal(complete(attempt.state), sender)
    await vi.waitFor(() => {
      expect(tokenCalls(context.calls)).toHaveLength(1)
    })
    await context.connection.disconnect()
    expect(await context.vault.readConnection()).toBeUndefined()

    exchange.resolve(json(200, b))

    expect(await answer).toEqual({ ok: false, error: 'unknown-attempt' })
    expect(await context.vault.readConnection()).toBeUndefined()
    expect(dump(context.storage)).not.toContain(b.refreshToken)
    expect(dump(context.storage)).not.toContain(b.accessToken)
    // The grant the server created for B is revoked, best effort, never installed.
    expect(revokes(context.calls).map((call) => call.bearer)).toContain(b.accessToken)
  })

  it('Cancel during a workspace switch: A stays, B is discarded and revoked', async () => {
    const context = harness()
    const a = tokenResponse({ grantId: GRANT_A })
    await context.auth.save(a)
    const b = tokenResponse({ grantId: GRANT_B, workspace: 'Globex' })
    const exchange = deferred<Response>()
    context.respond((call) => (isToken(call) ? exchange.promise : json(204)))
    const attempt = await pendingAttempt(context)

    const answer = context.connection.handleExternal(complete(attempt.state), sender)
    await vi.waitFor(() => {
      expect(tokenCalls(context.calls)).toHaveLength(1)
    })
    await context.connection.cancel()
    exchange.resolve(json(200, b))

    expect(await answer).toEqual({ ok: false, error: 'unknown-attempt' })
    expect((await context.vault.readConnection())?.id).toBe(GRANT_A)
    expect((await context.vault.readRefresh())?.token).toBe(a.refreshToken)
    expect(dump(context.storage)).not.toContain(b.refreshToken)
    const revoked = revokes(context.calls).map((call) => call.bearer)
    expect(revoked).toContain(b.accessToken)
    expect(revoked).not.toContain(a.accessToken)
  })

  it("closing the attempt's dashboard tab discards the pending exchange", async () => {
    const context = harness()
    const b = tokenResponse({ grantId: GRANT_B })
    const exchange = deferred<Response>()
    context.respond((call) => (isToken(call) ? exchange.promise : json(204)))
    const attempt = await pendingAttempt(context)

    const answer = context.connection.handleExternal(complete(attempt.state), sender)
    await vi.waitFor(() => {
      expect(tokenCalls(context.calls)).toHaveLength(1)
    })
    await context.connection.tabClosed(TAB)
    exchange.resolve(json(200, b))

    expect(await answer).toEqual({ ok: false, error: 'unknown-attempt' })
    expect(await context.vault.readConnection()).toBeUndefined()
  })

  it('a newer attempt wins over an older pending exchange', async () => {
    const context = harness()
    const b = tokenResponse({ grantId: GRANT_B, workspace: 'Globex' })
    const c = tokenResponse({ grantId: GRANT_C, workspace: 'Initech' })
    const exchangeB = deferred<Response>()
    context.respond((call) => {
      if (!isToken(call)) return json(204)
      return (call.body as { code?: string }).code === CODE_B ? exchangeB.promise : json(200, c)
    })
    const attemptB = await pendingAttempt(context)
    const answerB = context.connection.handleExternal(complete(attemptB.state, CODE_B), sender)
    await vi.waitFor(() => {
      expect(tokenCalls(context.calls)).toHaveLength(1)
    })

    const attemptC = await pendingAttempt(context)
    expect(
      await context.connection.handleExternal(complete(attemptC.state, CODE_C), sender),
    ).toMatchObject({
      ok: true,
    })
    exchangeB.resolve(json(200, b))

    expect(await answerB).toEqual({ ok: false, error: 'unknown-attempt' })
    expect((await context.vault.readConnection())?.id).toBe(GRANT_C)
    expect((await context.vault.readRefresh())?.token).toBe(c.refreshToken)
    expect(dump(context.storage)).not.toContain(b.refreshToken)
  })

  it('Disconnect clears local state at once, without waiting for the network', async () => {
    const context = harness()
    await context.auth.save(tokenResponse({ grantId: GRANT_A, accessExpiresAt: NOW - 1 }))
    const slow = deferred<Response>()
    context.respond(() => slow.promise)

    const disconnected = context.connection.disconnect()
    await vi.waitFor(async () => {
      expect(await context.vault.readConnection()).toBeUndefined()
    })
    expect(dump(context.storage)).not.toMatch(/clr_|cla_/)

    slow.resolve(json(401))
    expect(await disconnected).toEqual({ serverConfirmed: false })
    expect(await context.vault.readConnection()).toBeUndefined()
  })
})

describe('one attempt, one exchange', () => {
  it('two simultaneous messages for the same attempt reach the token endpoint once', async () => {
    const context = harness()
    const b = tokenResponse({ grantId: GRANT_B })
    context.respond((call) => (isToken(call) ? json(200, b) : json(204)))
    const attempt = await pendingAttempt(context)

    const answers = await Promise.all([
      context.connection.handleExternal(complete(attempt.state), sender),
      context.connection.handleExternal(complete(attempt.state), sender),
    ])

    expect(tokenCalls(context.calls)).toHaveLength(1)
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1)
    expect(answers.filter((answer) => !answer.ok)).toEqual([
      { ok: false, error: 'unknown-attempt' },
    ])
    expect((await context.vault.readConnection())?.id).toBe(GRANT_B)
    expect(revokes(context.calls)).toEqual([])
  })
})

describe('credential writes respect the life cycle', () => {
  it("Disconnect during the exchange's credential write wins: nothing is left behind", async () => {
    const context = harness()
    const b = tokenResponse({ grantId: GRANT_B })
    context.respond((call) => (isToken(call) ? json(200, b) : json(204)))
    const attempt = await pendingAttempt(context)
    const hold = context.storage.local.holdNextSet('cl.connection')

    const answer = context.connection.handleExternal(complete(attempt.state), sender)
    await hold.reached
    const disconnected = context.connection.disconnect()
    await flush()
    hold.release()
    await Promise.allSettled([answer, disconnected])

    expect(await context.vault.readConnection()).toBeUndefined()
    expect(dump(context.storage)).not.toContain(b.refreshToken)
  })

  it('a refresh write interrupted by Disconnect does not bring the connection back', async () => {
    const context = harness()
    await context.auth.save(tokenResponse({ grantId: GRANT_A, accessExpiresAt: NOW - 1 }))
    const rotated = tokenResponse({ grantId: GRANT_A })
    context.respond((call) => (isToken(call) ? json(200, rotated) : json(204)))
    const hold = context.storage.local.holdNextSet('cl.connection')

    const token = context.auth.accessToken()
    await hold.reached
    const disconnected = context.connection.disconnect()
    await flush()
    hold.release()
    await Promise.allSettled([token, disconnected])

    expect(await context.vault.readConnection()).toBeUndefined()
    expect(dump(context.storage)).not.toContain(rotated.refreshToken)
  })
})

describe('late refresh answers', () => {
  it('a refresh started for an old connection is not shared with the new one', async () => {
    const context = harness()
    const a = tokenResponse({ grantId: GRANT_A, accessExpiresAt: NOW - 1 })
    await context.auth.save(a)
    const refreshA = deferred<Response>()
    const b = tokenResponse({ grantId: GRANT_B, accessExpiresAt: NOW - 1 })
    const b2 = tokenResponse({ grantId: GRANT_B })
    context.respond((call) => {
      const body = call.body as { refreshToken?: string }
      if (body.refreshToken === a.refreshToken) return refreshA.promise
      if (body.refreshToken === b.refreshToken) return json(200, b2)
      return json(204)
    })

    const forA = context.auth.accessToken()
    await vi.waitFor(() => {
      expect(tokenCalls(context.calls)).toHaveLength(1)
    })
    await context.auth.save(b)
    const forB = context.auth.accessToken()

    expect(await forB).toBe(b2.accessToken)
    refreshA.resolve(json(200, tokenResponse({ grantId: GRANT_A })))
    await expect(forA).rejects.toBeInstanceOf(ConnectionEndedError)
    expect((await context.vault.readRefresh())?.token).toBe(b2.refreshToken)
  })

  it('a refused refresh of the old connection does not end the new one', async () => {
    const context = harness()
    const a = tokenResponse({ grantId: GRANT_A, accessExpiresAt: NOW - 1 })
    await context.auth.save(a)
    const refreshA = deferred<Response>()
    context.respond((call) => (isToken(call) ? refreshA.promise : json(204)))

    const forA = context.auth.accessToken()
    await vi.waitFor(() => {
      expect(tokenCalls(context.calls)).toHaveLength(1)
    })
    const b = tokenResponse({ grantId: GRANT_B })
    await context.auth.save(b)
    refreshA.resolve(json(401))

    await expect(forA).rejects.toBeInstanceOf(ConnectionEndedError)
    expect((await context.vault.readConnection())?.id).toBe(GRANT_B)
    expect(await context.vault.readEnded()).toBeUndefined()
  })

  it('a second 401 answered to the old connection does not clear the new one', async () => {
    const context = harness()
    const a = tokenResponse({ grantId: GRANT_A })
    await context.auth.save(a)
    const a2 = tokenResponse({ grantId: GRANT_A })
    const retry = deferred<Response>()
    let sessionCalls = 0
    context.respond((call) => {
      if (isToken(call)) return json(200, a2)
      if (call.path !== EXTENSION_PATHS.session) return json(204)
      sessionCalls += 1
      return sessionCalls === 1 ? json(401) : retry.promise
    })

    const check = context.auth.authorized(EXTENSION_PATHS.session, undefined)
    await vi.waitFor(() => {
      expect(sessionCalls).toBe(2)
    })
    const b = tokenResponse({ grantId: GRANT_B })
    await context.auth.save(b)
    retry.resolve(json(401))

    await expect(check).rejects.toBeInstanceOf(ConnectionEndedError)
    expect((await context.vault.readConnection())?.id).toBe(GRANT_B)
    expect((await context.vault.readRefresh())?.token).toBe(b.refreshToken)
  })
})
