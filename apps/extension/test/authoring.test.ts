import {
  extensionAuthoringGuidePath,
  extensionAuthoringGuidesPath,
  extensionAuthoringStepsPath,
  originMatchPattern,
  type Guide,
  type TargetDescriptor,
} from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { createAuth } from '../src/background/auth'
import {
  createAuthoring,
  MAX_LOCAL_DRAFT_CHARS,
  type AuthoringChrome,
} from '../src/background/authoring'
import { createLifecycle } from '../src/background/lifecycle'
import type { PageSender } from '../src/background/site-access'
import { createVault } from '../src/background/vault'
import { captureTarget } from '../src/content/capture/descriptor'
import { PICKER_TTL_MS, type DraftStep } from '../src/messaging/protocol'
import {
  deferred,
  fakeApi,
  GRANT_B,
  json,
  memoryStorage,
  NOW,
  tokenResponse,
  type Call,
} from './support/fakes'

const CRM = 'https://crm.acme.test'
const TAB = 4
const OTHER_TAB = 5
const DOC = 'doc-1'
const APP = '01a10a2e-864b-75bc-8800-aa3f01a05320'
const OTHER_APP = '01a10a2e-864b-75bc-8800-aa3f01a05321'
const GUIDE_A = '01a10a2e-864b-75bc-8800-aa3f01a05330'
const GUIDE_B = '01a10a2e-864b-75bc-8800-aa3f01a05331'

function guide(id: string, revision = 1, overrides: Partial<Guide> = {}): Guide {
  return {
    id,
    applicationId: APP,
    title: id === GUIDE_A ? 'Create a customer' : 'Edit a customer',
    description: '',
    status: 'draft',
    revision,
    stepCount: 0,
    latestVersion: null,
    hasUnpublishedChanges: true,
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
    archivedAt: null,
    startUrlPattern: null,
    steps: [],
    ...overrides,
  }
}

/** A real descriptor, captured from a jsdom page on the session's origin. */
function descriptor(href = `${CRM}/customers`): TargetDescriptor {
  document.body.innerHTML = '<button data-testid="save-customer">Save customer</button>'
  const button = document.querySelector('button')
  if (!button) throw new Error('no button')
  const outcome = captureTarget(button, {
    extensionVersion: '0.1.0',
    capturedAt: new Date(NOW),
    href,
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.descriptor
}

/** What Chrome reports for the content script of the bound page. */
const page = (overrides: Partial<PageSender> = {}): PageSender => ({
  url: `${CRM}/customers`,
  origin: CRM,
  frameId: 0,
  documentId: DOC,
  tab: { id: TAB } as chrome.tabs.Tab,
  ...overrides,
})

type Route = (call: Call) => Response | Promise<Response> | undefined

async function setup(options: { route?: Route; maxLocalDraftChars?: number } = {}) {
  let clock = NOW
  let route: Route | undefined = options.route
  const storage = memoryStorage()
  const { api, calls } = fakeApi((call) => {
    const answer = route?.(call)
    if (answer) return answer
    if (call.path === extensionAuthoringGuidePath(APP, GUIDE_A)) return json(200, guide(GUIDE_A))
    if (call.path === extensionAuthoringGuidePath(APP, GUIDE_B)) return json(200, guide(GUIDE_B))
    if (call.path.startsWith(`${extensionAuthoringGuidesPath(APP)}?`)) {
      return json(200, { items: [guide(GUIDE_A), guide(GUIDE_B)], nextCursor: null })
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'Guide not found.' } })
  })
  const granted = new Set([originMatchPattern(CRM)])
  const tabs = new Map([
    [TAB, `${CRM}/customers`],
    [OTHER_TAB, `${CRM}/deals`],
  ])
  const sent: {
    tabId: number
    message: { type: string; captureId?: string }
    documentId: string
  }[] = []
  let pageAnswers = true
  let answer = (_message: { type: string }): unknown => ({ ok: true, data: null })
  const closePanel = vi.fn(() => Promise.resolve())
  const chrome: AuthoringChrome = {
    hasHostAccess: (pattern) => Promise.resolve(granted.has(pattern)),
    tabUrl: (tabId) => Promise.resolve(tabs.get(tabId)),
    sendToTab: (tabId, message, documentId) => {
      sent.push({ tabId, message: message as { type: string }, documentId })
      return pageAnswers
        ? Promise.resolve(answer(message as { type: string }))
        : Promise.reject(new Error('No document'))
    },
    closePanel,
  }
  const notify = vi.fn()

  /** The worker's pieces over the same storage: called again to simulate a restart. */
  function start() {
    const vault = createVault(storage)
    const lifecycle = createLifecycle()
    const auth = createAuth({
      vault,
      api,
      lifecycle,
      now: () => clock,
      onEnded: () => Promise.resolve(),
    })
    const authoring = createAuthoring({
      vault,
      auth,
      lifecycle,
      chrome,
      now: () => clock,
      applicationsFor: (origin) =>
        Promise.resolve(
          origin === CRM
            ? [
                { id: APP, name: 'Acme CRM' },
                { id: OTHER_APP, name: 'Acme CRM (beta)' },
              ]
            : [],
        ),
      notify,
      ...(options.maxLocalDraftChars !== undefined && {
        maxLocalDraftChars: options.maxLocalDraftChars,
      }),
    })
    return { vault, lifecycle, auth, authoring }
  }

  const worker = start()
  await worker.auth.save(tokenResponse())
  const connection = await worker.vault.readConnection()
  if (!connection) throw new Error('not connected')
  await worker.vault.writeSites(connection.workspace.id, [CRM])
  await worker.vault.writePages({ [String(TAB)]: { origin: CRM, documentId: DOC } })

  return {
    ...worker,
    storage,
    calls,
    sent,
    closePanel,
    notify,
    granted,
    tabs,
    restart: start,
    tick: (ms: number) => (clock += ms),
    setRoute: (next: Route) => {
      route = next
    },
    pageGone: () => {
      pageAnswers = false
    },
    answerWith: (next: (message: { type: string }) => unknown) => {
      answer = next
    },
    /** Disconnect as the connection manager does it: credentials cleared in one transition. */
    disconnect: () =>
      worker.lifecycle.exclusive(async () => {
        worker.lifecycle.invalidateCredentials()
        await worker.vault.clearConnection(false, clock)
      }),
  }
}

/** Attached, with guide A open: the state a capture starts from. */
async function editing(options: { route?: Route; maxLocalDraftChars?: number } = {}) {
  const context = await setup(options)
  const attached = await context.authoring.attach(TAB)
  if (!attached.ok) throw new Error(attached.error.message)
  const panelId = attached.data.panelId
  const opened = await context.authoring.open(panelId, APP, GUIDE_A)
  if (!opened.ok) throw new Error(opened.error.message)
  return { ...context, panelId }
}

async function capturing(options: { route?: Route } = {}) {
  const context = await editing(options)
  const started = await context.authoring.startCapture(context.panelId)
  if (!started.ok) throw new Error(started.error.message)
  return { ...context, captureId: started.data.captureId }
}

const step = (overrides: Partial<DraftStep> = {}): DraftStep => ({
  id: null,
  title: 'Save the customer',
  body: { version: 1, blocks: [] },
  target: null,
  urlPattern: null,
  placement: 'auto',
  ...overrides,
})

describe('attaching a side panel', () => {
  it('binds the session to the connection, the tab, its origin and its document', async () => {
    const { authoring, vault } = await setup()

    const attached = await authoring.attach(TAB)

    expect(attached).toMatchObject({
      ok: true,
      data: {
        origin: CRM,
        workspace: { name: 'Acme' },
        applications: [
          { id: APP, name: 'Acme CRM' },
          { id: OTHER_APP, name: 'Acme CRM (beta)' },
        ],
      },
    })
    expect(await vault.readAuthoring()).toMatchObject({
      tabId: TAB,
      origin: CRM,
      documentId: DOC,
      guide: null,
      capture: null,
    })
  })

  it('refuses pages where ContextLayer is not running for this connection', async () => {
    const context = await setup()

    expect(await context.authoring.attach(OTHER_TAB)).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE' },
    })
    context.granted.clear()
    expect(await context.authoring.attach(TAB)).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE' },
    })
    await context.disconnect()
    expect(await context.authoring.attach(TAB)).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'Connect ContextLayer first.' },
    })
  })

  it('lets a newer panel take over: the older one is told it moved and can do nothing', async () => {
    const { authoring, panelId } = await editing()

    const newer = await authoring.attach(TAB)

    expect(newer.ok).toBe(true)
    expect(await authoring.state(panelId)).toEqual({ state: 'ended', reason: 'moved' })
    expect(await authoring.startCapture(panelId)).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    })
  })
})

describe('capturing an element', () => {
  it('asks the bound document for one element and offers the validated result for review', async () => {
    const { authoring, sent, panelId, captureId, notify } = await capturing()

    expect(sent).toEqual([
      {
        tabId: TAB,
        documentId: DOC,
        message: { type: 'picker.start', captureId, ttlMs: PICKER_TTL_MS },
      },
    ])
    const target = descriptor()
    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: target }),
    ).toEqual({ accepted: true })
    expect(notify).toHaveBeenCalled()
    expect(await authoring.takeCapture(panelId, captureId)).toEqual({
      ok: true,
      data: { id: captureId, state: 'done', descriptor: target, reason: null },
    })
  })

  it('rejects an unsolicited capture', async () => {
    const { authoring, panelId } = await editing()

    expect(
      await authoring.pickerResult(page(), 'Zk3_q-9xYt2LmN8pQ4rS', {
        ok: true,
        descriptor: descriptor(),
      }),
    ).toEqual({ accepted: false })
    expect(await authoring.state(panelId)).toMatchObject({ state: 'active', capture: null })
  })

  it('rejects answers from another tab, frame, document or origin', async () => {
    const { authoring, panelId, captureId } = await capturing()
    const answer = { ok: true as const, descriptor: descriptor() }

    for (const sender of [
      page({ tab: { id: OTHER_TAB } as chrome.tabs.Tab }),
      page({ frameId: 3 }),
      page({ documentId: 'doc-2' }),
      page({ documentId: undefined }),
      page({ url: 'https://evil.test/customers', origin: 'https://evil.test' }),
      page({ origin: 'https://evil.test' }),
    ]) {
      expect(await authoring.pickerResult(sender, captureId, answer)).toEqual({ accepted: false })
    }
    expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
      data: { state: 'pending', descriptor: null },
    })
  })

  it('accepts one answer per request: a repeated message changes nothing', async () => {
    const { authoring, panelId, captureId } = await capturing()
    const first = descriptor()
    const second = descriptor(`${CRM}/other`)

    await authoring.pickerResult(page(), captureId, { ok: true, descriptor: first })
    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: second }),
    ).toEqual({ accepted: false })
    expect(await authoring.pickerCancelled(page(), captureId, 'escape')).toEqual({
      accepted: false,
    })
    expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
      data: { state: 'done', descriptor: first },
    })
  })

  it('ignores a capture that arrives after Cancel, and stops the picker', async () => {
    const { authoring, panelId, captureId, sent } = await capturing()

    await authoring.cancelCapture(panelId)

    expect(sent.at(-1)).toEqual({
      tabId: TAB,
      documentId: DOC,
      message: { type: 'picker.stop', captureId },
    })
    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: descriptor() }),
    ).toEqual({ accepted: false })
    expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
      data: { state: 'cancelled', descriptor: null },
    })
  })

  it('expires a request after its time limit', async () => {
    const { authoring, panelId, captureId, tick } = await capturing()
    tick(PICKER_TTL_MS)

    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: descriptor() }),
    ).toEqual({ accepted: false })
    expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
      data: { state: 'expired' },
    })
  })

  it('never offers a descriptor the shared schema refuses, or one from another host', async () => {
    for (const forged of [
      { ...descriptor(), version: 2 },
      { ...descriptor(), cookies: 'session=1' },
      { ...descriptor(), locators: [] },
      descriptor('https://evil.test/customers'),
      '<img src=x onerror=alert(1)>',
    ]) {
      const { authoring, panelId, captureId } = await capturing()

      expect(
        await authoring.pickerResult(page(), captureId, { ok: true, descriptor: forged }),
      ).toEqual({ accepted: true })
      expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
        data: {
          state: 'failed',
          descriptor: null,
          reason: 'The selected element could not be validated. Try another one.',
        },
      })
    }
  })

  it('reports what the page could not capture, as text for the panel', async () => {
    const { authoring, panelId, captureId } = await capturing()

    await authoring.pickerResult(page(), captureId, {
      ok: false,
      reason: 'Elements inside frames are not supported yet.',
    })

    expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
      data: { state: 'failed', reason: 'Elements inside frames are not supported yet.' },
    })
  })

  it('cancels a capture when another guide is opened, so it cannot land in the wrong guide', async () => {
    const { authoring, panelId, captureId, sent } = await capturing()

    await authoring.open(panelId, APP, GUIDE_B)

    expect(sent.at(-1)?.message).toEqual({ type: 'picker.stop', captureId })
    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: descriptor() }),
    ).toEqual({ accepted: false })
    expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    })
  })

  it('rejects a capture for an older session', async () => {
    const { authoring, captureId } = await capturing()
    await authoring.attach(TAB)

    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: descriptor() }),
    ).toEqual({ accepted: false })
  })

  it('pauses when the page is reloaded and continues only when asked', async () => {
    const { authoring, vault, panelId, captureId } = await capturing()

    await vault.writePages({ [String(TAB)]: { origin: CRM, documentId: 'doc-2' } })
    await authoring.pageHello(page({ documentId: 'doc-2' }))

    expect(await authoring.state(panelId)).toMatchObject({
      state: 'active',
      paused: 'navigated',
      capture: { id: captureId, state: 'cancelled' },
    })
    expect(await authoring.startCapture(panelId)).toMatchObject({
      ok: false,
      error: { code: 'PAGE_CHANGED' },
    })
    expect(await authoring.resume(panelId)).toEqual({ ok: true, data: { done: true } })
    expect(await vault.readAuthoring()).toMatchObject({ documentId: 'doc-2', paused: null })
    expect((await authoring.startCapture(panelId)).ok).toBe(true)
  })

  it('pauses when the page no longer answers', async () => {
    const { authoring, panelId, pageGone } = await editing()
    pageGone()

    expect(await authoring.startCapture(panelId)).toMatchObject({
      ok: false,
      error: { code: 'PAGE_CHANGED' },
    })
    expect(await authoring.state(panelId)).toMatchObject({ paused: 'page-gone' })
  })

  it('survives the worker stopping between the request and the answer', async () => {
    const { restart, panelId, captureId } = await capturing()

    const { authoring } = restart()

    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: descriptor() }),
    ).toEqual({ accepted: true })
    expect(await authoring.takeCapture(panelId, captureId)).toMatchObject({
      data: { state: 'done' },
    })
  })
})

describe('loading guides', () => {
  it('lists and opens guides only for applications registered on this page', async () => {
    const { authoring, panelId } = await editing()

    expect(await authoring.guides(panelId, APP)).toMatchObject({
      ok: true,
      data: { items: [{ id: GUIDE_A }, { id: GUIDE_B }] },
    })
    expect(await authoring.guides(panelId, '01a10a2e-864b-75bc-8800-aa3f01a05399')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
  })

  it('keeps the guide picked last when an earlier load answers late', async () => {
    const slow = deferred<Response>()
    const context = await setup({
      route: (call) =>
        call.path === extensionAuthoringGuidePath(APP, GUIDE_A) ? slow.promise : undefined,
    })
    const attached = await context.authoring.attach(TAB)
    if (!attached.ok) throw new Error('attach')
    const { panelId } = attached.data

    const first = context.authoring.open(panelId, APP, GUIDE_A)
    await vi.waitFor(() => {
      expect(context.calls).toHaveLength(1)
    })
    expect(await context.authoring.open(panelId, APP, GUIDE_B)).toMatchObject({ ok: true })
    slow.resolve(json(200, guide(GUIDE_A)))

    expect(await first).toMatchObject({ ok: false, error: { code: 'STALE' } })
    expect(await context.authoring.state(panelId)).toMatchObject({
      guide: { applicationId: APP, guideId: GUIDE_B },
    })
  })

  it('drops a 200 that arrives after the connection changed', async () => {
    const slow = deferred<Response>()
    const context = await setup({
      route: (call) =>
        call.path === extensionAuthoringGuidePath(APP, GUIDE_A) ? slow.promise : undefined,
    })
    const attached = await context.authoring.attach(TAB)
    if (!attached.ok) throw new Error('attach')

    const opening = context.authoring.open(attached.data.panelId, APP, GUIDE_A)
    await vi.waitFor(() => {
      expect(context.calls).toHaveLength(1)
    })
    await context.auth.save(tokenResponse({ grantId: GRANT_B, workspace: 'Other' }))
    slow.resolve(json(200, guide(GUIDE_A)))

    expect(await opening).toMatchObject({ ok: false, error: { code: 'STALE' } })
  })
})

describe('saving', () => {
  const request = { expectedRevision: 1, steps: [] }

  it('replaces the steps with the expected revision and returns the saved guide', async () => {
    const context = await editing({
      route: (call) =>
        call.method === 'PUT' ? json(200, guide(GUIDE_A, 2, { stepCount: 0 })) : undefined,
    })

    const saved = await context.authoring.save(context.panelId, 'op-000001', APP, GUIDE_A, request)

    expect(saved).toMatchObject({
      ok: true,
      data: { operationId: 'op-000001', guide: { revision: 2 } },
    })
    expect(context.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: extensionAuthoringStepsPath(APP, GUIDE_A),
      body: request,
    })
  })

  it('explains conflicts and refusals with the server message', async () => {
    const answers: [number, string, string][] = [
      [
        409,
        'CONFLICT',
        'This guide was changed somewhere else. Load the latest draft before saving.',
      ],
      [403, 'FORBIDDEN', 'Your role in this workspace cannot edit guides.'],
      [404, 'NOT_FOUND', 'Guide not found.'],
    ]
    for (const [status, code, message] of answers) {
      const context = await editing({
        route: (call) =>
          call.method === 'PUT'
            ? json(status, { error: { code: status === 409 ? 'CONFLICT' : 'FORBIDDEN', message } })
            : undefined,
      })
      expect(
        await context.authoring.save(context.panelId, 'op-000001', APP, GUIDE_A, request),
      ).toEqual({ ok: false, error: { code, message } })
    }
  })

  it('never claims a lost answer failed: the outcome is unknown', async () => {
    for (const answer of [
      () => Promise.reject(new Error('socket hang up')),
      () => json(500, { error: { code: 'INTERNAL_ERROR', message: 'Boom.' } }),
      () => json(200, { not: 'a guide' }),
    ]) {
      const context = await editing({
        route: (call) => (call.method === 'PUT' ? answer() : undefined),
      })
      expect(
        await context.authoring.save(context.panelId, 'op-000001', APP, GUIDE_A, request),
      ).toMatchObject({ ok: false, error: { code: 'OUTCOME_UNKNOWN' } })
    }
  })

  it('reports a save answered after Disconnect as stale, not as saved', async () => {
    const slow = deferred<Response>()
    const context = await editing({
      route: (call) => (call.method === 'PUT' ? slow.promise : undefined),
    })

    const saving = context.authoring.save(context.panelId, 'op-000001', APP, GUIDE_A, request)
    await vi.waitFor(() => {
      expect(context.calls.at(-1)?.method).toBe('PUT')
    })
    await context.disconnect()
    slow.resolve(json(200, guide(GUIDE_A, 2)))

    expect(await saving).toMatchObject({ ok: false, error: { code: 'STALE' } })
  })

  it('runs one save at a time and only for the open guide', async () => {
    const slow = deferred<Response>()
    const context = await editing({
      route: (call) => (call.method === 'PUT' ? slow.promise : undefined),
    })

    const first = context.authoring.save(context.panelId, 'op-000001', APP, GUIDE_A, request)
    await vi.waitFor(() => {
      expect(context.calls.at(-1)?.method).toBe('PUT')
    })
    expect(
      await context.authoring.save(context.panelId, 'op-000002', APP, GUIDE_A, request),
    ).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
    expect(
      await context.authoring.save(context.panelId, 'op-000003', APP, GUIDE_B, request),
    ).toMatchObject({ ok: false, error: { code: 'STALE' } })
    slow.resolve(json(200, guide(GUIDE_A, 2)))
    expect((await first).ok).toBe(true)
  })
})

describe('ending the session', () => {
  it('ends when the panel closes, without leaving a picker on the page', async () => {
    const { authoring, panelId, captureId, sent } = await capturing()

    await authoring.detach(panelId)

    expect(sent.at(-1)?.message).toEqual({ type: 'picker.stop', captureId })
    expect(await authoring.state(panelId)).toEqual({ state: 'ended', reason: 'closed' })
    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: descriptor() }),
    ).toEqual({ accepted: false })
  })

  it('ends on Chrome closing the panel, the tab closing or Exit', async () => {
    const closed = await capturing()
    await closed.authoring.panelClosed(TAB)
    expect(await closed.authoring.state(closed.panelId)).toEqual({
      state: 'ended',
      reason: 'closed',
    })

    const tab = await editing()
    await tab.authoring.tabClosed(TAB)
    expect(await tab.authoring.state(tab.panelId)).toEqual({ state: 'ended', reason: 'tab-closed' })

    const exited = await editing()
    await exited.authoring.exit(exited.panelId)
    expect(await exited.authoring.state(exited.panelId)).toEqual({
      state: 'ended',
      reason: 'exited',
    })
    expect(exited.closePanel).toHaveBeenCalledWith(TAB)
  })

  it('ends when Chrome withdraws the site, stopping the picker', async () => {
    const { authoring, panelId, captureId, granted, sent } = await capturing()
    granted.clear()

    await authoring.verify()

    expect(await authoring.state(panelId)).toEqual({ state: 'ended', reason: 'site-off' })
    expect(sent.at(-1)?.message).toEqual({ type: 'picker.stop', captureId })
  })

  it('ends on Disconnect while capturing; a late capture is ignored', async () => {
    const { authoring, panelId, captureId, disconnect, vault } = await capturing()

    await disconnect()
    await authoring.verify()

    expect(await vault.readAuthoring()).toBeUndefined()
    expect(await authoring.state(panelId)).toEqual({ state: 'ended', reason: 'disconnected' })
    expect(
      await authoring.pickerResult(page(), captureId, { ok: true, descriptor: descriptor() }),
    ).toEqual({ accepted: false })
  })

  it('ends when another connection replaces this one', async () => {
    const { authoring, auth, panelId } = await editing()

    await auth.save(tokenResponse({ grantId: GRANT_B }))
    await authoring.verify()

    expect(await authoring.state(panelId)).toEqual({ state: 'ended', reason: 'connection-changed' })
  })
})

describe('the local copy of unsaved steps', () => {
  const draft = (steps: DraftStep[] = [step()]) => ({
    applicationId: APP,
    guideId: GUIDE_A,
    baseRevision: 1,
    steps,
  })

  it('is offered back for the same connection and guide', async () => {
    const { authoring, panelId } = await editing()

    expect(await authoring.writeLocal(panelId, draft())).toEqual({
      ok: true,
      data: { stored: true, reason: null },
    })
    expect(await authoring.open(panelId, APP, GUIDE_A)).toMatchObject({
      ok: true,
      data: {
        local: { guideId: GUIDE_A, baseRevision: 1, steps: [{ title: 'Save the customer' }] },
      },
    })
    expect(await authoring.open(panelId, APP, GUIDE_B)).toMatchObject({
      ok: true,
      data: { local: null },
    })
  })

  it('never reaches another connection, and Disconnect deletes it', async () => {
    const context = await editing()
    await context.authoring.writeLocal(context.panelId, draft())

    // Another account connects without a Disconnect in between.
    await context.auth.save(tokenResponse({ grantId: GRANT_B }))
    await context.authoring.verify()
    const connection = await context.vault.readConnection()
    await context.vault.writeSites(connection?.workspace.id ?? '', [CRM])
    const attached = await context.authoring.attach(TAB)
    if (!attached.ok) throw new Error('attach')
    expect(await context.authoring.open(attached.data.panelId, APP, GUIDE_A)).toMatchObject({
      data: { local: null },
    })

    await context.authoring.writeLocal(attached.data.panelId, draft())
    await context.disconnect()
    expect(await context.vault.readDraft()).toBeUndefined()
    expect(await context.vault.readAuthoring()).toBeUndefined()
  })

  it('is refused, not cut, when it would be too large', async () => {
    const { authoring, panelId, vault } = await editing({ maxLocalDraftChars: 500 })
    const target = descriptor()

    expect(await authoring.writeLocal(panelId, draft([step({ target })]))).toEqual({
      ok: true,
      data: { stored: false, reason: 'too-large' },
    })
    expect(await vault.readDraft()).toBeUndefined()
  })

  it('fits the largest draft the API accepts', () => {
    const target = descriptor()
    const longest = Array.from({ length: 50 }, () =>
      step({
        title: 'x'.repeat(120),
        body: {
          version: 1,
          blocks: Array.from({ length: 20 }, () => ({
            type: 'paragraph' as const,
            children: [{ type: 'text' as const, text: 'y'.repeat(100) }],
          })),
        },
        target,
      }),
    )
    expect(JSON.stringify(draft(longest)).length).toBeLessThan(MAX_LOCAL_DRAFT_CHARS)
  })
})

describe('previewing a step', () => {
  it('asks the bound document to preview the element it kept for that capture', async () => {
    const { authoring, panelId, captureId, sent, answerWith } = await capturing()
    answerWith((message) =>
      message.type === 'preview.show'
        ? { ok: true, data: { shown: true } }
        : { ok: true, data: null },
    )

    expect(
      await authoring.showPreview(panelId, captureId, 'Save the customer', ['Click Save.']),
    ).toEqual({ ok: true, data: { shown: true } })
    expect(sent.at(-1)).toEqual({
      tabId: TAB,
      documentId: DOC,
      message: {
        type: 'preview.show',
        captureId,
        title: 'Save the customer',
        lines: ['Click Save.'],
      },
    })
  })

  it('reports an element the page no longer holds, without looking for another one', async () => {
    const { authoring, panelId, captureId, answerWith } = await capturing()
    answerWith(() => ({ ok: true, data: { shown: false } }))

    expect(await authoring.showPreview(panelId, captureId, 'Save', [])).toEqual({
      ok: true,
      data: { shown: false },
    })
  })

  it('previews nothing on a page that changed, or for another panel', async () => {
    const { authoring, vault, panelId, captureId } = await capturing()
    await vault.writePages({ [String(TAB)]: { origin: CRM, documentId: 'doc-2' } })

    expect(await authoring.showPreview(panelId, captureId, 'Save', [])).toMatchObject({
      ok: false,
      error: { code: 'PAGE_CHANGED' },
    })
    expect(
      await authoring.showPreview('Pn1_other-panel-0123456789ab', captureId, 'Save', []),
    ).toMatchObject({ ok: false, error: { code: 'STALE' } })
  })

  it('removes a preview when the session ends', async () => {
    const { authoring, panelId, sent } = await editing()

    await authoring.detach(panelId)

    expect(sent.some((entry) => entry.message.type === 'preview.hide')).toBe(true)
  })
})
