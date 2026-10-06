import {
  extensionGuidePath,
  originMatchPattern,
  type GuideSnapshot,
  type PublishedGuide,
} from '@contextlayer/shared'
import { describe, expect, it } from 'vitest'

import { createAuth } from '../src/background/auth'
import { createLifecycle } from '../src/background/lifecycle'
import { createPlayer, type PlayerChrome } from '../src/background/player'
import type { PageSender } from '../src/background/site-access'
import { createVault } from '../src/background/vault'
import { playerStepSchema, type PlayerStep } from '../src/messaging/protocol'
import { deferred, fakeApi, json, memoryStorage, NOW, tokenResponse } from './support/fakes'

/**
 * The Guide Player's run in the worker (Phase 6a): bound to the connection,
 * one tab, its document and one published version; kept in `storage.session`
 * so a stopped worker keeps the step; never moved by a stale request.
 */

const CRM = 'https://crm.acme.test'
const TAB = 4
const DOC = 'doc-1'
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

const page = (overrides: Partial<PageSender> = {}): PageSender => ({
  url: `${CRM}/customers`,
  origin: CRM,
  frameId: 0,
  documentId: DOC,
  tab: { id: TAB } as chrome.tabs.Tab,
  ...overrides,
})

async function world(options: { guide?: () => Response | Promise<Response>; url?: string } = {}) {
  const storage = memoryStorage()
  const { api, calls } = fakeApi((call) =>
    call.path === extensionGuidePath(GUIDE)
      ? (options.guide?.() ?? json(200, published()))
      : json(404),
  )
  const sent: { tabId: number; message: { type: string; step?: PlayerStep }; doc: string }[] = []
  let answer: (message: { type: string }) => unknown = () => ({ ok: true, data: { shown: true } })
  const access = new Set([originMatchPattern(CRM)])
  const url = options.url ?? `${CRM}/customers`
  const chrome: PlayerChrome = {
    hasHostAccess: (pattern) => Promise.resolve(access.has(pattern)),
    tabUrl: () => Promise.resolve(url),
    sendToTab: (tabId, message, doc) => {
      const typed = message as { type: string; step?: PlayerStep }
      sent.push({ tabId, message: typed, doc })
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
  await vault.writeSites(workspaceId, [CRM])
  await vault.writePages({ [String(TAB)]: { origin: CRM, documentId: DOC } })

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
    revokeAccess() {
      access.clear()
    },
    shown: () => sent.filter((entry) => entry.message.type === 'player.show'),
    hidden: () => sent.filter((entry) => entry.message.type === 'player.hide'),
    disconnect: () =>
      first.lifecycle.exclusive(async () => {
        first.lifecycle.invalidateCredentials()
        await vault.clearConnection(false, NOW)
      }),
  }
}

async function started(w: Awaited<ReturnType<typeof world>>) {
  const result = await w.player.start(TAB, GUIDE, 2)
  if (!result.ok) throw new Error(result.error.message)
  return result.data.runId
}

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
    expect(await w.vault.readPlayer()).toMatchObject({
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
    expect([...w.storage.local.data.keys()]).not.toContain('cl.player')
  })

  it('refuses while Edit Mode is open on the tab, before asking the API', async () => {
    const w = await world()
    await w.vault.writeAuthoring({
      id: 's',
      panelId: 'p',
      grantId: 'g',
      workspaceId: w.workspaceId,
      tabId: TAB,
      origin: CRM,
      documentId: DOC,
      applicationIds: [APP],
      paused: null,
      guide: null,
      loadId: null,
      capture: null,
      createdAt: NOW,
    })

    const result = await w.player.start(TAB, GUIDE, 2)

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
    expect(result.ok || result.error.message).toMatch(/Edit Mode/)
    expect(w.calls.filter((call) => call.path === extensionGuidePath(GUIDE))).toHaveLength(0)
    expect(await w.vault.readPlayer()).toBeUndefined()
  })

  it('refuses a page ContextLayer does not run on', async () => {
    const off = await world()
    await off.vault.writeSites(off.workspaceId, [])
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
    expect(await w.vault.readPlayer()).toBeUndefined()
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    await w.disconnect()
    response.resolve(json(200, published()))

    expect(await start).toMatchObject({ ok: false, error: { code: 'STALE' } })
    expect(await w.vault.readPlayer()).toBeUndefined()
    expect(w.shown()).toHaveLength(0)
  })

  it('stores nothing when the page reloads while the guide loads', async () => {
    const response = deferred<Response>()
    const w = await world({ guide: () => response.promise })

    const start = w.player.start(TAB, GUIDE, 2)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await w.vault.writePages({ [String(TAB)]: { origin: CRM, documentId: 'doc-2' } })
    response.resolve(json(200, published()))

    expect(await start).toMatchObject({ ok: false, error: { code: 'PAGE_CHANGED' } })
    expect(await w.vault.readPlayer()).toBeUndefined()
    expect(w.shown()).toHaveLength(0)
  })

  it('refuses when Edit Mode attaches to the tab while the guide loads', async () => {
    const response = deferred<Response>()
    const w = await world({ guide: () => response.promise })

    const start = w.player.start(TAB, GUIDE, 2)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await w.vault.writeAuthoring({
      id: 's',
      panelId: 'p',
      grantId: 'g',
      workspaceId: w.workspaceId,
      tabId: TAB,
      origin: CRM,
      documentId: DOC,
      applicationIds: [APP],
      paused: null,
      guide: null,
      loadId: null,
      capture: null,
      createdAt: NOW,
    })
    response.resolve(json(200, published()))

    expect(await start).toMatchObject({ ok: false, error: { code: 'NOT_AVAILABLE' } })
    expect(await w.vault.readPlayer()).toBeUndefined()
    expect(w.shown()).toHaveLength(0)
  })

  it('ends the run when the page cannot show it', async () => {
    const w = await world()
    w.answerWith(() => new Error('Could not establish connection.'))

    expect(await w.player.start(TAB, GUIDE, 2)).toMatchObject({
      ok: false,
      error: { code: 'PAGE_CHANGED' },
    })
    expect(await w.vault.readPlayer()).toBeUndefined()
  })

  it('replaces the run already playing and removes its UI', async () => {
    const w = await world()
    const first = await started(w)

    const second = await started(w)

    expect(second).not.toBe(first)
    expect(w.hidden().map((entry) => entry.message)).toEqual([
      { type: 'player.hide', runId: first },
    ])
    expect((await w.vault.readPlayer())?.id).toBe(second)
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
    expect((await w.vault.readPlayer())?.step).toBe(1)
  })

  it('accepts requests from the run page only', async () => {
    const w = await world()
    const runId = await started(w)

    for (const sender of [
      page({ documentId: 'doc-2' }),
      page({ tab: { id: TAB + 1 } as chrome.tabs.Tab }),
      page({ frameId: 3 }),
      page({ url: 'https://evil.test/', origin: 'https://evil.test' }),
      page({ origin: 'https://evil.test' }),
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
    expect(await w.vault.readPlayer()).toMatchObject({ id: runId, step: 0 })
  })

  it('keeps the current step when the worker stops and starts again', async () => {
    const w = await world()
    const runId = await started(w)
    await w.player.go(page(), runId, 0, 'next')

    const { player } = w.restart()

    expect(await player.go(page(), runId, 1, 'next')).toMatchObject({
      ok: true,
      data: { runId, index: 2, generation: 2 },
    })
  })
})

describe('ending a guide', () => {
  it('ends on Finish or Close, and a late request never brings it back', async () => {
    const w = await world()
    const runId = await started(w)

    expect(await w.player.end(page(), runId)).toEqual({ ok: true, data: { done: true } })

    expect(await w.vault.readPlayer()).toBeUndefined()
    expect(await w.player.go(page(), runId, 0, 'next')).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    })
    expect(await w.vault.readPlayer()).toBeUndefined()
  })

  it('ends when a new document says hello in its tab, not for the same document', async () => {
    const w = await world()
    await started(w)

    await w.player.pageHello(page())
    expect(await w.vault.readPlayer()).toBeDefined()
    await w.player.pageHello(page({ tab: { id: TAB + 1 } as chrome.tabs.Tab, documentId: 'x' }))
    expect(await w.vault.readPlayer()).toBeDefined()

    await w.player.pageHello(page({ documentId: 'doc-2' }))
    expect(await w.vault.readPlayer()).toBeUndefined()
  })

  it('ends when its tab closes', async () => {
    const w = await world()
    await started(w)

    await w.player.tabClosed(TAB + 1)
    expect(await w.vault.readPlayer()).toBeDefined()
    await w.player.tabClosed(TAB)
    expect(await w.vault.readPlayer()).toBeUndefined()
  })

  it('ends and removes its UI when Edit Mode attaches to its tab', async () => {
    const w = await world()
    const runId = await started(w)

    await w.player.endOnTab(TAB)

    expect(await w.vault.readPlayer()).toBeUndefined()
    expect(w.hidden()).toEqual([{ tabId: TAB, doc: DOC, message: { type: 'player.hide', runId } }])
  })

  it('ends and removes its UI when the site is turned off or access is withdrawn', async () => {
    const off = await world()
    await started(off)
    await off.vault.writeSites(off.workspaceId, [])
    const withdrawn = await world()
    await started(withdrawn)
    withdrawn.revokeAccess()

    for (const w of [off, withdrawn]) {
      await w.player.verify()
      expect(await w.vault.readPlayer()).toBeUndefined()
      expect(w.hidden()).toHaveLength(1)
    }
  })

  it('is forgotten with the connection (Disconnect, revocation)', async () => {
    const w = await world()
    await started(w)

    await w.disconnect()
    await w.player.verify()

    expect(await w.vault.readPlayer()).toBeUndefined()
    expect(JSON.stringify([...w.storage.session.data])).not.toContain('Create a customer')
  })

  it('keeps a run that is still valid', async () => {
    const w = await world()
    const runId = await started(w)

    await w.player.verify()

    expect((await w.vault.readPlayer())?.id).toBe(runId)
    expect(w.hidden()).toHaveLength(0)
  })
})
