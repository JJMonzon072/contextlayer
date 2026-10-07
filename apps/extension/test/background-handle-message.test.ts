import type { HealthReport } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import type { Authoring } from '../src/background/authoring'
import type { Player } from '../src/background/player'
import type { MessageResult } from '../src/messaging/protocol'
import { classifySender, handleBackgroundMessage } from '../src/background/handle-message'

const report: HealthReport = {
  status: 'ok',
  service: 'contextlayer-api',
  version: '0.0.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 1,
  checks: { database: { status: 'up', latencyMs: 1 } },
}

const EXTENSION_ID = 'own-extension-id'
const popupSender = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` }
const contentScriptSender = {
  id: EXTENSION_ID,
  url: 'http://localhost:5173/',
  tab: { id: 7 } as chrome.tabs.Tab,
}
const panelSender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/sidepanel.html?tab=7`,
}
const PANEL = 'Pn1_panel-id-0123456789abcdef'
const CAPTURE = 'Zk3_q-9xYt2LmN8pQ4rS'
const GUIDE = '01a10a2e-864b-75bc-8800-aa3f01a05330'
const APP = '01a10a2e-864b-75bc-8800-aa3f01a05320'

const status = {
  state: 'disconnected',
  connection: null,
  attemptPending: false,
  persistent: true,
  api: 'ok',
} as const

function deps(fetchApiHealth = vi.fn(() => Promise.resolve(report))) {
  return {
    extensionId: EXTENSION_ID,
    fetchApiHealth,
    onApiError: vi.fn(),
    connection: {
      status: vi.fn(() => Promise.resolve(status)),
      start: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve({ serverConfirmed: true })),
    },
    site: {
      applications: vi.fn(() => Promise.resolve({ applications: [] })),
      status: vi.fn(() => Promise.resolve(siteStatus)),
      requestActivation: vi.fn(() => Promise.resolve({ intentId: 'intent-1' })),
      cancelActivation: vi.fn(() => Promise.resolve({ cancelled: true })),
      disable: vi.fn(() => Promise.resolve(siteStatus)),
      hello: vi.fn(() => Promise.resolve({ active: true })),
    },
    authoring: fakeAuthoring(),
    player: fakePlayer(),
  }
}

/** Every player entry point, recording calls. */
function fakePlayer() {
  const answer = () => Promise.resolve({ ok: true, data: { done: true } } as MessageResult<never>)
  return {
    start: vi.fn(answer),
    go: vi.fn(answer),
    end: vi.fn(answer),
    resume: vi.fn(answer),
    command: vi.fn(() => Promise.resolve(true)),
    tabClosed: vi.fn(() => Promise.resolve()),
    endOnTab: vi.fn(() => Promise.resolve()),
    verify: vi.fn(() => Promise.resolve()),
  } satisfies Player
}

/** Every authoring entry point, recording calls; answers do not matter to the router. */
function fakeAuthoring() {
  // The router passes answers through untouched; their shape is not its concern.
  const done = () => Promise.resolve({ ok: true, data: { done: true } } as MessageResult<never>)
  return {
    attach: vi.fn(done),
    state: vi.fn(() => Promise.resolve({ state: 'ended' as const, reason: 'closed' as const })),
    guides: vi.fn(done),
    open: vi.fn(done),
    create: vi.fn(done),
    resume: vi.fn(done),
    startCapture: vi.fn(done),
    cancelCapture: vi.fn(done),
    takeCapture: vi.fn(done),
    save: vi.fn(done),
    writeLocal: vi.fn(done),
    clearLocal: vi.fn(done),
    showPreview: vi.fn(done),
    hidePreview: vi.fn(done),
    exit: vi.fn(done),
    detach: vi.fn(done),
    panelClosed: vi.fn(() => Promise.resolve()),
    pageHello: vi.fn(() => Promise.resolve()),
    tabClosed: vi.fn(() => Promise.resolve()),
    verify: vi.fn(() => Promise.resolve()),
    pickerResult: vi.fn(() => Promise.resolve({ accepted: true })),
    pickerCancelled: vi.fn(() => Promise.resolve({ accepted: true })),
  } satisfies Authoring
}

/** One valid request of each Edit Mode type. */
const AUTHORING = [
  { type: 'authoring.attach', tabId: 7 },
  { type: 'authoring.state', panelId: PANEL },
  { type: 'authoring.guides', panelId: PANEL, applicationId: APP },
  { type: 'authoring.open', panelId: PANEL, applicationId: APP, guideId: GUIDE },
  { type: 'authoring.create', panelId: PANEL, applicationId: APP, title: 'Create a customer' },
  { type: 'authoring.resume', panelId: PANEL },
  { type: 'authoring.capture.start', panelId: PANEL },
  { type: 'authoring.capture.cancel', panelId: PANEL },
  { type: 'authoring.capture.take', panelId: PANEL, captureId: CAPTURE },
  {
    type: 'authoring.save',
    panelId: PANEL,
    operationId: 'op-123456',
    applicationId: APP,
    guideId: GUIDE,
    request: { expectedRevision: 3, steps: [] },
  },
  {
    type: 'authoring.local.write',
    panelId: PANEL,
    draft: { applicationId: APP, guideId: GUIDE, baseRevision: 3, steps: [] },
    version: 4,
  },
  { type: 'authoring.local.clear', panelId: PANEL, guideId: GUIDE, version: 4 },
  {
    type: 'authoring.preview.show',
    panelId: PANEL,
    captureId: CAPTURE,
    title: 'Save the customer',
    lines: ['Click Save.'],
  },
  { type: 'authoring.preview.hide', panelId: PANEL },
  { type: 'authoring.exit', panelId: PANEL },
  { type: 'authoring.detach', panelId: PANEL },
  {
    type: 'authoring.detach',
    panelId: PANEL,
    final: {
      draft: { applicationId: APP, guideId: GUIDE, baseRevision: 3, steps: [] },
      version: 5,
    },
  },
] as const

const siteStatus = { state: 'unsupported' } as const

const RUN = 'Rn1_run-id-0123456789abcdef'

const PRIVILEGED = [
  { type: 'api.health.get' },
  { type: 'connection.status' },
  { type: 'connection.start' },
  { type: 'connection.cancel' },
  { type: 'connection.disconnect' },
  { type: 'applications.list' },
  { type: 'site.status', tabId: 7 },
  { type: 'site.requestActivation', tabId: 7 },
  { type: 'site.cancelActivation', intentId: 'intent-1' },
  { type: 'site.disable', tabId: 7 },
] as const

describe('classifySender', () => {
  it('recognises extension pages by their own origin, even when opened in a tab', () => {
    expect(classifySender(popupSender, EXTENSION_ID)).toBe('extension-page')
    expect(
      classifySender({ ...popupSender, tab: { id: 3 } as chrome.tabs.Tab }, EXTENSION_ID),
    ).toBe('extension-page')
  })

  it('tells the Edit Mode side panel apart by its path', () => {
    expect(classifySender(panelSender, EXTENSION_ID)).toBe('side-panel')
    expect(
      classifySender(
        { ...panelSender, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html.popup.html` },
        EXTENSION_ID,
      ),
    ).toBe('extension-page')
  })

  it('recognises content scripts as senders from a web page tab', () => {
    expect(classifySender(contentScriptSender, EXTENSION_ID)).toBe('content-script')
  })

  it('rejects other extensions and senders without a page or tab', () => {
    expect(classifySender({ ...popupSender, id: 'someone-else' }, EXTENSION_ID)).toBeUndefined()
    expect(classifySender({ id: EXTENSION_ID, url: 'https://evil.example/' }, EXTENSION_ID)).toBe(
      undefined,
    )
  })
})

describe('handleBackgroundMessage', () => {
  it('returns the API health report to the popup', async () => {
    const result = await handleBackgroundMessage({ type: 'api.health.get' }, popupSender, deps())

    expect(result).toEqual({ ok: true, data: report })
  })

  it('maps API failures to API_UNREACHABLE and reports them', async () => {
    const failingDeps = deps(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))

    const result = await handleBackgroundMessage(
      { type: 'api.health.get' },
      popupSender,
      failingDeps,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'API_UNREACHABLE' } })
    expect(failingDeps.onApiError).toHaveBeenCalledOnce()
  })

  it('rejects messages from unrecognised senders', async () => {
    const result = await handleBackgroundMessage(
      { type: 'api.health.get' },
      { id: 'someone-else', url: 'chrome-extension://someone-else/page.html' },
      deps(),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('rejects unknown or malformed messages', async () => {
    const result = await handleBackgroundMessage({ type: 'guides.delete' }, popupSender, deps())

    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('runs connection commands for extension pages', async () => {
    const handlers = deps()

    expect(
      await handleBackgroundMessage({ type: 'connection.start' }, popupSender, handlers),
    ).toEqual({ ok: true, data: status })
    expect(
      await handleBackgroundMessage({ type: 'connection.disconnect' }, popupSender, handlers),
    ).toEqual({ ok: true, data: { serverConfirmed: true } })
    expect(handlers.connection.start).toHaveBeenCalledOnce()
    expect(handlers.connection.disconnect).toHaveBeenCalledOnce()
  })

  it('never runs privileged commands for content scripts', async () => {
    const handlers = deps()

    for (const request of PRIVILEGED) {
      const result = await handleBackgroundMessage(request, contentScriptSender, handlers)
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    for (const command of [
      handlers.fetchApiHealth,
      ...Object.values(handlers.connection),
      ...Object.values(handlers.site),
    ]) {
      expect(command).not.toHaveBeenCalled()
    }
  })

  it('lets a content script ask about its own page only, with the sender Chrome reports', async () => {
    const handlers = deps()

    expect(
      await handleBackgroundMessage({ type: 'page.hello' }, contentScriptSender, handlers),
    ).toEqual({ ok: true, data: { active: true } })
    expect(handlers.site.hello).toHaveBeenCalledWith(contentScriptSender)
    // A forged tab id or origin in the message is not part of the contract.
    expect(
      await handleBackgroundMessage(
        { type: 'page.hello', origin: 'https://other.example' },
        contentScriptSender,
        handlers,
      ),
    ).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
    // The popup has no page to ask about.
    expect(
      await handleBackgroundMessage({ type: 'page.hello' }, popupSender, handlers),
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('routes site commands from the popup with the tab it names', async () => {
    const handlers = deps()

    await handleBackgroundMessage(
      { type: 'site.requestActivation', tabId: 12 },
      popupSender,
      handlers,
    )

    expect(handlers.site.requestActivation).toHaveBeenCalledWith(12)
    expect(
      await handleBackgroundMessage(
        { type: 'site.requestActivation', tabId: -1 },
        popupSender,
        handlers,
      ),
    ).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('rejects extra fields instead of ignoring them', async () => {
    const result = await handleBackgroundMessage(
      { type: 'connection.start', url: 'https://evil.example/' },
      popupSender,
      deps(),
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('runs Edit Mode requests for the side panel only', async () => {
    for (const request of AUTHORING) {
      for (const sender of [popupSender, contentScriptSender]) {
        const handlers = deps()
        expect(
          await handleBackgroundMessage(request, sender, handlers),
          `${request.type} from ${sender.url}`,
        ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
        for (const command of Object.values(handlers.authoring)) {
          expect(command).not.toHaveBeenCalled()
        }
      }
      expect(await handleBackgroundMessage(request, panelSender, deps())).toMatchObject({
        ok: true,
      })
    }
  })

  it('never lets the side panel run connection or site commands', async () => {
    const handlers = deps()

    for (const request of PRIVILEGED) {
      const result = await handleBackgroundMessage(request, panelSender, handlers)
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
  })

  it('accepts capture answers from content scripts only, with the sender Chrome reports', async () => {
    const outcome = { ok: false, reason: 'Elements inside frames are not supported yet.' }
    const result = { type: 'picker.result', captureId: CAPTURE, outcome }
    const cancelled = { type: 'picker.cancelled', captureId: CAPTURE, reason: 'escape' }

    for (const sender of [popupSender, panelSender]) {
      expect(await handleBackgroundMessage(result, sender, deps())).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      })
    }
    const handlers = deps()
    await handleBackgroundMessage(result, contentScriptSender, handlers)
    await handleBackgroundMessage(cancelled, contentScriptSender, handlers)
    expect(handlers.authoring.pickerResult).toHaveBeenCalledWith(
      contentScriptSender,
      CAPTURE,
      outcome,
    )
    expect(handlers.authoring.pickerCancelled).toHaveBeenCalledWith(
      contentScriptSender,
      CAPTURE,
      'escape',
    )
    // A content script cannot slip a save or a workspace into its answer.
    expect(
      await handleBackgroundMessage(
        { ...result, guideId: GUIDE, workspaceId: 'w' },
        contentScriptSender,
        deps(),
      ),
    ).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('tells Edit Mode when an authorized page says hello', async () => {
    const handlers = deps()

    await handleBackgroundMessage({ type: 'page.hello' }, contentScriptSender, handlers)

    expect(handlers.authoring.pageHello).toHaveBeenCalledWith(contentScriptSender)
  })

  it('starts a guide from extension pages only', async () => {
    const start = { type: 'player.start', tabId: 7, guideId: GUIDE, version: 2 }

    for (const sender of [contentScriptSender, panelSender]) {
      const handlers = deps()
      expect(await handleBackgroundMessage(start, sender, handlers)).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      })
      expect(handlers.player.start).not.toHaveBeenCalled()
    }
    const handlers = deps()
    await handleBackgroundMessage(start, popupSender, handlers)
    expect(handlers.player.start).toHaveBeenCalledWith(7, GUIDE, 2)
    expect(
      await handleBackgroundMessage({ ...start, version: 0 }, popupSender, deps()),
    ).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('moves and ends a run from content scripts only, with the sender Chrome reports', async () => {
    const go = { type: 'player.go', runId: RUN, generation: 3, direction: 'next' }
    const end = { type: 'player.end', runId: RUN, reason: 'closed' }

    for (const sender of [popupSender, panelSender]) {
      const handlers = deps()
      for (const request of [go, end]) {
        expect(await handleBackgroundMessage(request, sender, handlers)).toMatchObject({
          ok: false,
          error: { code: 'FORBIDDEN' },
        })
      }
      expect(handlers.player.go).not.toHaveBeenCalled()
      expect(handlers.player.end).not.toHaveBeenCalled()
    }
    const handlers = deps()
    await handleBackgroundMessage(go, contentScriptSender, handlers)
    await handleBackgroundMessage(end, contentScriptSender, handlers)
    expect(handlers.player.go).toHaveBeenCalledWith(contentScriptSender, RUN, 3, 'next')
    expect(handlers.player.end).toHaveBeenCalledWith(contentScriptSender, RUN)
    // A page cannot jump to a step, pick a guide or skip the generation.
    for (const forged of [
      { ...go, direction: 'last' },
      { ...go, generation: -1 },
      { ...go, step: 2 },
      { ...end, guideId: GUIDE },
      { ...end, reason: 'skipped' },
      { type: 'player.go', runId: RUN, direction: 'next' },
    ]) {
      expect(await handleBackgroundMessage(forged, contentScriptSender, deps())).toMatchObject({
        ok: false,
        error: { code: 'BAD_REQUEST' },
      })
    }
  })

  it('ends the guide playing on a tab once Edit Mode attached to it, never before', async () => {
    const handlers = deps()
    await handleBackgroundMessage({ type: 'authoring.attach', tabId: 7 }, panelSender, handlers)
    expect(handlers.player.endOnTab).toHaveBeenCalledWith(7)

    const refused = deps()
    refused.authoring.attach.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'No.' },
    })
    await handleBackgroundMessage({ type: 'authoring.attach', tabId: 7 }, panelSender, refused)
    expect(refused.player.endOnTab).not.toHaveBeenCalled()
  })

  it('lets a page ask for its tab’s guide, and tells the player when a site is turned off', async () => {
    const handlers = deps()

    await handleBackgroundMessage({ type: 'page.hello' }, contentScriptSender, handlers)
    await handleBackgroundMessage({ type: 'player.resume' }, contentScriptSender, handlers)
    await handleBackgroundMessage({ type: 'site.disable', tabId: 7 }, popupSender, handlers)

    // A hello alone never moves a run: the page asks for it with player.resume.
    expect(handlers.player.resume).toHaveBeenCalledExactlyOnceWith(contentScriptSender)
    expect(handlers.player.verify).toHaveBeenCalledOnce()
    for (const sender of [popupSender, panelSender]) {
      expect(
        await handleBackgroundMessage({ type: 'player.resume' }, sender, deps()),
      ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    // Nothing in the message chooses a run, a tab or a document.
    for (const forged of [
      { type: 'player.resume', tabId: 3 },
      { type: 'player.resume', runId: 'Rn1_run-id-0123456789abcdef' },
    ]) {
      expect(await handleBackgroundMessage(forged, contentScriptSender, deps())).toMatchObject({
        ok: false,
        error: { code: 'BAD_REQUEST' },
      })
    }
  })
})
