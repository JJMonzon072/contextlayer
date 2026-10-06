import {
  EXTENSION_PATHS,
  extensionGuidePath,
  originMatchPattern,
  type GuideSnapshot,
  type PublishedGuide,
} from '@contextlayer/shared'
import { describe, expect, it } from 'vitest'

import { ApiUnreachableError } from '../src/background/api-client'
import { createAuth } from '../src/background/auth'
import { createLifecycle } from '../src/background/lifecycle'
import { createPlayer, type PlayerChrome } from '../src/background/player'
import type { PageSender } from '../src/background/site-access'
import { createVault, type AuthoringSession } from '../src/background/vault'
import { playerStepSchema, type PlayerStep } from '../src/messaging/protocol'
import { deferred, fakeApi, json, memoryStorage, NOW, tokenResponse } from './support/fakes'

/**
 * The Guide Player's runs in the worker (Phase 6a): at most one per tab, each
 * bound to the connection, its tab, document and one published version; kept
 * in `storage.session` so a stopped worker keeps the step; never moved by a
 * stale request, never brought back by a late message, and ended when the
 * server no longer accepts the connection.
 */

const CRM = 'https://crm.acme.test'
const WIKI = 'https://wiki.acme.test'
const TAB = 4
const OTHER_TAB = 5
const DOC = 'doc-1'
const OTHER_DOC = 'doc-5'
const APP = '01a10a2e-864b-75bc-8800-aa3f01a05320'
const GUIDE = '01a10a2e-864b-75bc-8800-aa3f01a05330'
const STEP_IDS = [
  '01a10a2e-864b-75bc-8800-aa3f01a05341',
  '01a10a2e-864b-75bc-8800-aa3f01a05342',
  '01a10a2e-864b-75bc-8800-aa3f01a05343',
]

const paragraph = (text: string) => ({
  version: 1 as const,
  blocks: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] }],
})

function snapshot(
  startUrlPattern: GuideSnapshot['guide']['startUrlPattern'] = null,
): GuideSnapshot {
  const titles = ['Open the form', 'Type the name', 'Save the customer']
  return {
    version: 1,
    guide: {
      id: GUIDE,
      applicationId: APP,
      title: 'Create a customer',
      description: '',
      startUrlPattern,
    },
    // Stored out of order on purpose: steps play in `position` order.
    steps: [2, 0, 1].map((position) => ({
      id: STEP_IDS[position] ?? '',
      position,
      title: titles[position] ?? '',
      body: paragraph(`Instructions for ${titles[position] ?? ''}`),
      target: null,
      urlPattern: null,
      placement: 'auto' as const,
    })),
  }
}

function published(version = 2, start?: GuideSnapshot['guide']['startUrlPattern']) {
  return {
    guideId: GUIDE,
    applicationId: APP,
    version,
    publishedAt: '2026-10-06T09:00:00.000Z',
    snapshot: snapshot(start),
  } satisfies PublishedGuide
}

/** Each tab shows its own site and document. */
const TABS: Record<number, { origin: string; url: string; doc: string }> = {
  [TAB]: { origin: CRM, url: `${CRM}/customers`, doc: DOC },
  [OTHER_TAB]: { origin: WIKI, url: `${WIKI}/home`, doc: OTHER_DOC },
}

/** The sender Chrome reports for the top frame of a tab's document. */
const page = (overrides: Partial<PageSender> = {}, tabId = TAB): PageSender => ({
  url: TABS[tabId]?.url,
  origin: TABS[tabId]?.origin,
  frameId: 0,
  documentId: TABS[tabId]?.doc,
  tab: { id: tabId } as chrome.tabs.Tab,
  ...overrides,
})

interface Sent {
  tabId: number
  message: { type: string; step?: PlayerStep; runId?: string }
  doc: string
}

const call = (entry: { method: string; path: string }) => `${entry.method} ${entry.path}`

async function world(options: { guide?: () => Response | Promise<Response>; url?: string } = {}) {
  const storage = memoryStorage()
  /** `ok`, revoked on the server (bearer 401, refresh refused), or unreachable. */
  let server: 'ok' | 'revoked' | 'unreachable' = 'ok'
  const { api, calls } = fakeApi((request) => {
    if (server === 'unreachable') throw new ApiUnreachableError('connection refused')
    if (request.path === EXTENSION_PATHS.token) {
      return server === 'revoked' ? json(400, { error: { code: 'x', message: 'x' } }) : json(500)
    }
    if (server === 'revoked') return json(401)
    if (request.path === EXTENSION_PATHS.session) return json(200, {})
    if (request.path === extensionGuidePath(GUIDE)) {
      return options.guide?.() ?? json(200, published())
    }
    return json(404)
  })
  const sent: Sent[] = []
  /** Answers held back, by message type: the next such message waits for its release. */
  const held = new Map<string, ReturnType<typeof deferred<unknown>>[]>()
  let answer: (message: { type: string }) => unknown = () => ({ ok: true, data: { shown: true } })
  const access = new Set([originMatchPattern(CRM), originMatchPattern(WIKI)])
  const chrome: PlayerChrome = {
    hasHostAccess: (pattern) => Promise.resolve(access.has(pattern)),
    tabUrl: (tabId) =>
      Promise.resolve(tabId === TAB && options.url ? options.url : TABS[tabId]?.url),
    sendToTab: (tabId, message, doc) => {
      const typed = message as Sent['message']
      sent.push({ tabId, message: typed, doc })
      const gate = held.get(typed.type)?.shift()
      if (gate) return gate.promise
      const reply = answer(typed)
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
    },
  }
  const vault = createVault(storage)
  await vault.ready()
  const make = () => {
    const lifecycle = createLifecycle()
    const auth = createAuth({
      vault,
      api,
      lifecycle,
      now: () => NOW,
      onEnded: () => Promise.resolve(),
    })
    const player = createPlayer({
      vault,
      auth,
      lifecycle,
      chrome,
      now: () => NOW,
      applicationsFor: () => Promise.resolve([{ id: APP }]),
    })
    return { lifecycle, auth, player }
  }
  const first = make()
  await first.auth.save(tokenResponse())
  const connection = await vault.readConnection()
  const workspaceId = connection?.workspace.id ?? ''
  await vault.writeSites(workspaceId, [CRM, WIKI])
  await vault.writePages({
    [String(TAB)]: { origin: CRM, documentId: DOC },
    [String(OTHER_TAB)]: { origin: WIKI, documentId: OTHER_DOC },
  })
  const authoringOn = (tabId: number): AuthoringSession => ({
    id: 's',
    panelId: 'p',
    grantId: connection?.id ?? '',
    workspaceId,
    tabId,
    origin: TABS[tabId]?.origin ?? CRM,
    documentId: TABS[tabId]?.doc ?? DOC,
    applicationIds: [APP],
    paused: null,
    guide: null,
    loadId: null,
    capture: null,
    createdAt: NOW,
  })

  return {
    ...first,
    storage,
    vault,
    calls,
    sent,
    workspaceId,
    /** The worker stopped and started again: new memory, same `storage.session`. */
    restart: () => make(),
    answerWith(next: (message: { type: string }) => unknown) {
      answer = next
    },
    /** Holds the answer to the next message of `type`; returns its release. */
    hold(type: string) {
      const gate = deferred<unknown>()
      held.set(type, [...(held.get(type) ?? []), gate])
      return (value: unknown = { ok: true, data: { shown: true } }) => {
        gate.resolve(value)
      }
    },
    serverSays(state: typeof server) {
      server = state
    },
    revokeAccess(origin = CRM) {
      access.delete(originMatchPattern(origin))
    },
    editModeOn: (tabId: number) => vault.writeAuthoring(authoringOn(tabId)),
    run: async (tabId = TAB) => (await vault.readPlayers())[String(tabId)],
    shown: () => sent.filter((entry) => entry.message.type === 'player.show'),
    hidden: () => sent.filter((entry) => entry.message.type === 'player.hide'),
    /** Every message sent to a page: its type, tab and run. */
    order: () =>
      sent.map(
        (entry) =>
          `${entry.message.type}:${String(entry.tabId)}:${entry.message.step?.runId ?? entry.message.runId ?? ''}`,
      ),
    disconnect: () =>
      first.lifecycle.exclusive(async () => {
        first.lifecycle.invalidateCredentials()
        await vault.clearConnection(false, NOW)
      }),
  }
}

type World = Awaited<ReturnType<typeof world>>

async function started(w: World, tabId = TAB) {
  const result = await w.player.start(tabId, GUIDE, 2)
  if (!result.ok) throw new Error(result.error.message)
  return result.data.runId
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('starting a guide', () => {
  it('shows the first step of the published version on the bound document', async () => {
    const w = await world()

    const runId = await started(w)

    const [show] = w.shown()
    expect(show).toMatchObject({ tabId: TAB, doc: DOC })
    expect(playerStepSchema.parse(show?.message.step)).toEqual({
      runId,
      generation: 0,
      guideTitle: 'Create a customer',
      index: 0,
      count: 3,
      title: 'Open the form',
      lines: ['Instructions for Open the form'],
      target: null,
      urlPattern: null,
      placement: 'auto',
    })
    expect(await w.run()).toMatchObject({
      id: runId,
      tabId: TAB,
      origin: CRM,
      documentId: DOC,
      guideId: GUIDE,
      version: 2,
      step: 0,
      generation: 0,
    })
    // Local run state only: nothing for the guide outside `storage.session`.
    expect(JSON.stringify([...w.storage.local.data])).not.toContain('Create a customer')
  })

  it('refuses while Edit Mode is open on the tab, before asking the API', async () => {
    const w = await world()
    await w.editModeOn(TAB)

    const result = await w.player.start(TAB, GUIDE, 2)

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
    expect(result.ok || result.error.message).toMatch(/Edit Mode/)
    expect(w.calls.filter((entry) => entry.path === extensionGuidePath(GUIDE))).toHaveLength(0)
    expect(await w.run()).toBeUndefined()
  })

  it('refuses a page ContextLayer does not run on', async () => {
    const off = await world()
    await off.vault.writeSites(off.workspaceId, [WIKI])
    const noAccess = await world()
    noAccess.revokeAccess()
    const notHello = await world()
    await notHello.vault.writePages({})

    for (const w of [off, noAccess, notHello]) {
      expect(await w.player.start(TAB, GUIDE, 2)).toMatchObject({
        ok: false,
        error: { code: 'NOT_AVAILABLE' },
      })
      expect(w.shown()).toHaveLength(0)
    }
  })

  it('never plays another version than the one listed', async () => {
    const w = await world({ guide: () => json(200, published(3)) })

    expect(await w.player.start(TAB, GUIDE, 2)).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    })
    expect(await w.run()).toBeUndefined()
  })

  it('starts only on the guide start page; no start page means any page of the site', async () => {
    const elsewhere = await world({
      guide: () => json(200, published(2, { pathname: '/customers/new' })),
    })
    expect(await elsewhere.player.start(TAB, GUIDE, 2)).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'This guide starts on another page of this site.' },
    })

    const there = await world({
      guide: () => json(200, published(2, { pathname: '/customers' })),
    })
    expect((await there.player.start(TAB, GUIDE, 2)).ok).toBe(true)

    const anywhere = await world({ url: `${CRM}/reports/2026` })
    expect((await anywhere.player.start(TAB, GUIDE, 2)).ok).toBe(true)
  })

  it('reports a guide that is no longer published', async () => {
    const w = await world({ guide: () => json(404, { error: { code: 'x', message: 'x' } }) })

    expect(await w.player.start(TAB, GUIDE, 2)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
  })

  it('stores nothing when Disconnect happens while the guide loads', async () => {
    const response = deferred<Response>()
    const w = await world({ guide: () => response.promise })

    const start = w.player.start(TAB, GUIDE, 2)
    await tick()
    await w.disconnect()
    response.resolve(json(200, published()))

    expect(await start).toMatchObject({ ok: false, error: { code: 'STALE' } })
    expect(await w.vault.readPlayers()).toEqual({})
    expect(w.shown()).toHaveLength(0)
  })

  it('stores nothing when the page reloads while the guide loads', async () => {
    const response = deferred<Response>()
    const w = await world({ guide: () => response.promise })

    const start = w.player.start(TAB, GUIDE, 2)
    await tick()
    await w.vault.writePages({ [String(TAB)]: { origin: CRM, documentId: 'doc-2' } })
    response.resolve(json(200, published()))

    expect(await start).toMatchObject({ ok: false, error: { code: 'PAGE_CHANGED' } })
    expect(await w.run()).toBeUndefined()
    expect(w.shown()).toHaveLength(0)
  })

  it('refuses when Edit Mode attaches to the tab while the guide loads', async () => {
    const response = deferred<Response>()
    const w = await world({ guide: () => response.promise })

    const start = w.player.start(TAB, GUIDE, 2)
    await tick()
    await w.editModeOn(TAB)
    await w.player.endOnTab(TAB)
    response.resolve(json(200, published()))

    expect((await start).ok).toBe(false)
    expect(await w.run()).toBeUndefined()
    expect(w.shown()).toHaveLength(0)
  })

  it('ends the run when the page cannot show it', async () => {
    const w = await world()
    w.answerWith(() => new Error('Could not establish connection.'))

    expect(await w.player.start(TAB, GUIDE, 2)).toMatchObject({
      ok: false,
      error: { code: 'PAGE_CHANGED' },
    })
    expect(await w.run()).toBeUndefined()
  })

  it('replaces the run already playing on the same tab and removes its UI', async () => {
    const w = await world()
    const first = await started(w)

    const second = await started(w)

    expect(second).not.toBe(first)
    expect(w.hidden().map((entry) => entry.message)).toEqual([
      { type: 'player.hide', runId: first },
    ])
    expect((await w.run())?.id).toBe(second)
  })
})

describe('guides in two tabs', () => {
  it('plays a guide in each tab at once', async () => {
    const w = await world()

    const a = await started(w, TAB)
    const b = await started(w, OTHER_TAB)

    expect((await w.run(TAB))?.id).toBe(a)
    expect((await w.run(OTHER_TAB))?.id).toBe(b)
    expect(w.order()).toEqual([
      `player.show:${String(TAB)}:${a}`,
      `player.show:${String(OTHER_TAB)}:${b}`,
    ])
  })

  it('moves only the run of the tab that asked', async () => {
    const w = await world()
    const a = await started(w, TAB)
    const b = await started(w, OTHER_TAB)

    expect(await w.player.go(page(), a, 0, 'next')).toMatchObject({
      ok: true,
      data: { runId: a, index: 1 },
    })

    expect(await w.run(TAB)).toMatchObject({ id: a, step: 1, generation: 1 })
    expect(await w.run(OTHER_TAB)).toMatchObject({ id: b, step: 0, generation: 0 })
  })

  it('never lets a page reach the run of another tab', async () => {
    const w = await world()
    await started(w, TAB)
    const b = await started(w, OTHER_TAB)

    // Tab 1's page naming tab 2's run, even claiming tab 2's document and origin.
    const forged = page({ url: `${WIKI}/home`, origin: WIKI, documentId: OTHER_DOC })
    for (const sender of [page(), forged]) {
      expect(await w.player.go(sender, b, 0, 'next')).toMatchObject({
        ok: false,
        error: { code: 'STALE' },
      })
      expect(await w.player.end(sender, b)).toEqual({ ok: true, data: { done: false } })
    }
    expect(await w.run(OTHER_TAB)).toMatchObject({ id: b, step: 0 })
  })

  it('finishing, closing or reloading one tab keeps the other', async () => {
    const finished = await world()
    const a = await started(finished, TAB)
    const b = await started(finished, OTHER_TAB)
    await finished.player.end(page(), a)
    expect(await finished.run(TAB)).toBeUndefined()
    expect((await finished.run(OTHER_TAB))?.id).toBe(b)

    const closed = await world()
    await started(closed, TAB)
    const kept = await started(closed, OTHER_TAB)
    await closed.player.tabClosed(TAB)
    expect(await closed.run(TAB)).toBeUndefined()
    expect((await closed.run(OTHER_TAB))?.id).toBe(kept)

    const reloaded = await world()
    await started(reloaded, TAB)
    const other = await started(reloaded, OTHER_TAB)
    await reloaded.player.pageHello(page({ documentId: 'doc-2' }))
    expect(await reloaded.run(TAB)).toBeUndefined()
    expect((await reloaded.run(OTHER_TAB))?.id).toBe(other)
  })

  it('replacing the run of one tab replaces only that run', async () => {
    const w = await world()
    const a = await started(w, TAB)
    const b = await started(w, OTHER_TAB)

    const again = await started(w, TAB)

    expect((await w.run(TAB))?.id).toBe(again)
    expect((await w.run(OTHER_TAB))?.id).toBe(b)
    expect(w.hidden().map((entry) => [entry.tabId, entry.message.runId])).toEqual([[TAB, a]])
  })

  it('Edit Mode on one tab ends only that tab’s guide', async () => {
    const w = await world()
    const a = await started(w, TAB)
    const b = await started(w, OTHER_TAB)

    await w.player.endOnTab(TAB)

    expect(await w.run(TAB)).toBeUndefined()
    expect((await w.run(OTHER_TAB))?.id).toBe(b)
    expect(w.hidden().map((entry) => [entry.tabId, entry.message.runId])).toEqual([[TAB, a]])
  })

  it('turning a site off ends the runs on that site only; Disconnect ends them all', async () => {
    const w = await world()
    const a = await started(w, TAB)
    const b = await started(w, OTHER_TAB)

    await w.vault.writeSites(w.workspaceId, [WIKI])
    await w.player.verify()

    expect(await w.run(TAB)).toBeUndefined()
    expect((await w.run(OTHER_TAB))?.id).toBe(b)
    expect(w.hidden().map((entry) => entry.message.runId)).toEqual([a])

    await w.disconnect()
    expect(await w.vault.readPlayers()).toEqual({})
  })

  it('withdrawn access ends the runs of that origin only', async () => {
    const w = await world()
    await started(w, TAB)
    const b = await started(w, OTHER_TAB)
    w.revokeAccess(CRM)

    await w.player.verify()

    expect(await w.run(TAB)).toBeUndefined()
    expect((await w.run(OTHER_TAB))?.id).toBe(b)
  })

  it('drops a malformed or misfiled run without touching the other tabs', async () => {
    const w = await world()
    const a = await started(w, TAB)
    const stored = w.storage.session.data.get('cl.players') as Record<string, unknown>
    w.storage.session.data.set('cl.players', {
      ...stored,
      [String(OTHER_TAB)]: { ...(stored[String(TAB)] as object) },
      '99': { id: 'broken' },
    })

    expect(Object.keys(await w.vault.readPlayers())).toEqual([String(TAB)])
    expect((await w.run(TAB))?.id).toBe(a)
  })
})

describe('moving through a guide', () => {
  it('goes Next and Previous within the guide, one generation per change', async () => {
    const w = await world()
    const runId = await started(w)

    const second = await w.player.go(page(), runId, 0, 'next')
    expect(second).toMatchObject({ ok: true, data: { index: 1, generation: 1 } })
    const third = await w.player.go(page(), runId, 1, 'next')
    expect(third).toMatchObject({ ok: true, data: { index: 2, title: 'Save the customer' } })
    expect(await w.player.go(page(), runId, 2, 'next')).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    })
    expect(await w.player.go(page(), runId, 2, 'previous')).toMatchObject({
      ok: true,
      data: { index: 1, generation: 3 },
    })
  })

  it('answers a request about an older step with the step shown now, without moving', async () => {
    const w = await world()
    const runId = await started(w)
    await w.player.go(page(), runId, 0, 'next')

    // A second click on the first step's Next.
    const late = await w.player.go(page(), runId, 0, 'next')

    expect(late).toMatchObject({ ok: true, data: { index: 1, generation: 1 } })
    expect((await w.run())?.step).toBe(1)
  })

  it('accepts requests from the run page only', async () => {
    const w = await world()
    const runId = await started(w)

    for (const sender of [
      page({ documentId: 'doc-2' }),
      page({ tab: { id: TAB + 10 } as chrome.tabs.Tab }),
      page({ frameId: 3 }),
      page({ url: 'https://evil.test/', origin: 'https://evil.test' }),
      page({ origin: 'https://evil.test' }),
      page({ tab: undefined }),
    ]) {
      expect(await w.player.go(sender, runId, 0, 'next')).toMatchObject({
        ok: false,
        error: { code: 'STALE' },
      })
      expect(await w.player.end(sender, runId)).toEqual({ ok: true, data: { done: false } })
    }
    expect(await w.player.go(page(), 'Rn1_other-run-0123456789', 0, 'next')).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    })
    expect(await w.run()).toMatchObject({ id: runId, step: 0 })
  })

  it('keeps the current step of every tab when the worker stops and starts again', async () => {
    const w = await world()
    const a = await started(w, TAB)
    const b = await started(w, OTHER_TAB)
    await w.player.go(page(), a, 0, 'next')

    const { player } = w.restart()

    expect(await player.go(page(), a, 1, 'next')).toMatchObject({
      ok: true,
      data: { runId: a, index: 2, generation: 2 },
    })
    expect(await player.go(page({}, OTHER_TAB), b, 0, 'next')).toMatchObject({
      ok: true,
      data: { runId: b, index: 1, generation: 1 },
    })
  })
})

describe('ending a guide', () => {
  it('ends on Finish or Close, and a late request never brings it back', async () => {
    const w = await world()
    const runId = await started(w)

    expect(await w.player.end(page(), runId)).toEqual({ ok: true, data: { done: true } })

    expect(await w.run()).toBeUndefined()
    expect(await w.player.go(page(), runId, 0, 'next')).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    })
    expect(await w.run()).toBeUndefined()
  })

  it('ends when a new document says hello in its tab, not for the same document', async () => {
    const w = await world()
    await started(w)

    await w.player.pageHello(page())
    expect(await w.run()).toBeDefined()
    await w.player.pageHello(page({ documentId: 'x' }, OTHER_TAB))
    expect(await w.run()).toBeDefined()

    await w.player.pageHello(page({ documentId: 'doc-2' }))
    expect(await w.run()).toBeUndefined()
  })

  it('ends and removes its UI when the site is turned off or access is withdrawn', async () => {
    const off = await world()
    await started(off)
    await off.vault.writeSites(off.workspaceId, [WIKI])
    const withdrawn = await world()
    await started(withdrawn)
    withdrawn.revokeAccess()

    for (const w of [off, withdrawn]) {
      await w.player.verify()
      expect(await w.run()).toBeUndefined()
      expect(w.hidden()).toHaveLength(1)
    }
  })

  it('is forgotten with the connection on Disconnect', async () => {
    const w = await world()
    await started(w)

    await w.disconnect()
    await w.player.verify()

    expect(await w.vault.readPlayers()).toEqual({})
    expect(JSON.stringify([...w.storage.session.data])).not.toContain('Create a customer')
  })

  it('keeps a run that is still valid', async () => {
    const w = await world()
    const runId = await started(w)

    await w.player.verify()

    expect((await w.run())?.id).toBe(runId)
    expect(w.hidden()).toHaveLength(0)
  })
})

describe('late messages never bring a run back', () => {
  it('a run ended while its page was answering is hidden after its show, never stored again', async () => {
    const w = await world()
    const release = w.hold('player.show')

    const start = w.player.start(TAB, GUIDE, 2)
    await tick()
    // The site is turned off before the page answered the show.
    await w.vault.writeSites(w.workspaceId, [WIKI])
    await w.player.verify()
    release()

    expect(await start).toMatchObject({ ok: false, error: { code: 'STALE' } })
    const a = w.shown()[0]?.message.step?.runId ?? ''
    expect(w.order()).toEqual([
      `player.show:${String(TAB)}:${a}`,
      `player.hide:${String(TAB)}:${a}`,
    ])
    expect(await w.run()).toBeUndefined()
  })

  it('a newer start on the same tab replaces a run whose show is late, in order', async () => {
    const w = await world()
    const release = w.hold('player.show')

    const startA = w.player.start(TAB, GUIDE, 2)
    await tick()
    const b = await started(w)
    release()

    expect(await startA).toMatchObject({ ok: false, error: { code: 'STALE' } })
    const a = w.shown()[0]?.message.step?.runId ?? ''
    expect(w.order()).toEqual([
      `player.show:${String(TAB)}:${a}`,
      `player.hide:${String(TAB)}:${a}`,
      `player.show:${String(TAB)}:${b}`,
    ])
    expect(Object.values(await w.vault.readPlayers()).map((run) => run.id)).toEqual([b])
  })

  it('an older start that loads slowly never replaces a newer one', async () => {
    const response = deferred<Response>()
    let loads = 0
    const w = await world({
      guide: () => (++loads === 1 ? response.promise : json(200, published())),
    })

    const startA = w.player.start(TAB, GUIDE, 2)
    await tick()
    const b = await started(w)
    response.resolve(json(200, published()))

    expect(await startA).toMatchObject({ ok: false, error: { code: 'STALE' } })
    expect(w.shown().map((entry) => entry.message.step?.runId)).toEqual([b])
    expect((await w.run())?.id).toBe(b)
  })

  it('Edit Mode attaching while the page answers ends the run for good', async () => {
    const w = await world()
    const release = w.hold('player.show')

    const start = w.player.start(TAB, GUIDE, 2)
    await tick()
    await w.editModeOn(TAB)
    await w.player.endOnTab(TAB)
    release()

    expect(await start).toMatchObject({ ok: false, error: { code: 'STALE' } })
    const a = w.shown()[0]?.message.step?.runId ?? ''
    expect(w.order()).toEqual([
      `player.show:${String(TAB)}:${a}`,
      `player.hide:${String(TAB)}:${a}`,
    ])
    expect(await w.run()).toBeUndefined()
  })
})

describe('a connection revoked on the server', () => {
  it('ends every run of that connection at the next step, and nothing brings them back', async () => {
    const w = await world()
    const a = await started(w, TAB)
    const b = await started(w, OTHER_TAB)
    // Revoked from Connected browsers: the API refuses the access token and the refresh.
    w.serverSays('revoked')
    const before = w.calls.length

    const next = await w.player.go(page(), a, 0, 'next')

    expect(next).toMatchObject({
      ok: false,
      error: { code: 'STALE', message: 'The connection to ContextLayer ended.' },
    })
    // Found by the existing bearer check, then the refused refresh (strict rotation).
    expect(w.calls.slice(before).map(call)).toEqual([
      `GET ${EXTENSION_PATHS.session}`,
      `POST ${EXTENSION_PATHS.token}`,
    ])
    expect(await w.vault.readConnection()).toBeUndefined()
    expect(await w.vault.readEnded()).toBeDefined()
    expect(await w.vault.readPlayers()).toEqual({})
    // Both pages are told to remove their guide.
    expect(
      w.hidden().map((entry) => `${String(entry.tabId)}:${entry.message.runId ?? ''}`),
    ).toEqual([`${String(TAB)}:${a}`, `${String(OTHER_TAB)}:${b}`])

    // A late request, even after the worker restarted, finds nothing.
    for (const player of [w.player, w.restart().player]) {
      expect(await player.go(page(), a, 0, 'next')).toMatchObject({
        ok: false,
        error: { code: 'STALE' },
      })
      expect(await player.go(page({}, OTHER_TAB), b, 0, 'next')).toMatchObject({
        ok: false,
        error: { code: 'STALE' },
      })
    }
    expect(await w.vault.readPlayers()).toEqual({})
  })

  it('does not take an unreachable API for a revocation', async () => {
    const w = await world()
    const runId = await started(w)
    w.serverSays('unreachable')

    expect(await w.player.go(page(), runId, 0, 'next')).toMatchObject({
      ok: true,
      data: { index: 1, generation: 1 },
    })
    expect(await w.vault.readConnection()).toBeDefined()
    expect((await w.run())?.step).toBe(1)
  })

  it('checks the connection on Previous and Next with the access token', async () => {
    const w = await world()
    const runId = await started(w)
    const before = w.calls.length

    await w.player.go(page(), runId, 0, 'next')
    await w.player.go(page(), runId, 1, 'previous')

    expect(w.calls.slice(before).map(call)).toEqual([
      `GET ${EXTENSION_PATHS.session}`,
      `GET ${EXTENSION_PATHS.session}`,
    ])
    expect(w.calls.slice(before).every((entry) => entry.bearer?.startsWith('cla_'))).toBe(true)
  })

  it('never calls the API for a request that is not about the page’s own run', async () => {
    const w = await world()
    const runId = await started(w)
    const before = w.calls.length

    await w.player.go(page({ documentId: 'doc-2' }), runId, 0, 'next')
    await w.player.go(page(), 'Rn1_other-run-0123456789', 0, 'next')

    expect(w.calls.length).toBe(before)
  })
})
