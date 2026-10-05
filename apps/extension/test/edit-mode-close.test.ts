import { extensionAuthoringGuidePath, originMatchPattern, type Guide } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { createAuth } from '../src/background/auth'
import { createAuthoring, type Authoring, type AuthoringChrome } from '../src/background/authoring'
import { createLifecycle } from '../src/background/lifecycle'
import { createVault } from '../src/background/vault'
import type { MessageResult } from '../src/messaging/protocol'
import type { AuthoringClient } from '../src/sidepanel/client'
import { createEditMode } from '../src/sidepanel/edit-mode'
import { deferred, fakeApi, json, memoryStorage, NOW, tokenResponse } from './support/fakes'

/**
 * Closing the side panel with the real panel logic (`createEditMode`) talking
 * to the real worker logic (`createAuthoring`) through a message channel that
 * behaves like Chrome's: asynchronous, delivered in the order sent, answers
 * that can be held back, and nothing sent by a panel once it is gone (after
 * `pagehide`, the page cannot send anything more).
 */

const CRM = 'https://crm.acme.test'
const TAB = 4
const DOC = 'doc-1'
const APP = '01a10a2e-864b-75bc-8800-aa3f01a05320'
const GUIDE = '01a10a2e-864b-75bc-8800-aa3f01a05330'
const STEP = '01a10a2e-864b-75bc-8800-aa3f01a05340'

const guide: Guide = {
  id: GUIDE,
  applicationId: APP,
  title: 'Create a customer',
  description: '',
  status: 'draft',
  revision: 1,
  stepCount: 1,
  latestVersion: null,
  hasUnpublishedChanges: true,
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  archivedAt: null,
  startUrlPattern: null,
  steps: [
    {
      id: STEP,
      position: 0,
      title: 'Open the form',
      body: { version: 1, blocks: [] },
      target: null,
      urlPattern: null,
      placement: 'auto',
    },
  ],
}

type Method = keyof AuthoringClient

async function world() {
  const storage = memoryStorage()
  const { api } = fakeApi((call) =>
    call.path === extensionAuthoringGuidePath(APP, GUIDE) ? json(200, guide) : json(404),
  )
  const sent: { type: string }[] = []
  const chrome: AuthoringChrome = {
    hasHostAccess: (pattern) => Promise.resolve(pattern === originMatchPattern(CRM)),
    tabUrl: () => Promise.resolve(`${CRM}/customers`),
    sendToTab: (_tabId, message) => {
      sent.push(message as { type: string })
      return Promise.resolve({ ok: true, data: null })
    },
    closePanel: () => Promise.resolve(),
  }
  const vault = createVault(storage)
  const lifecycle = createLifecycle()
  const auth = createAuth({
    vault,
    api,
    lifecycle,
    now: () => NOW,
    onEnded: () => Promise.resolve(),
  })
  const authoring: Authoring = createAuthoring({
    vault,
    auth,
    lifecycle,
    chrome,
    now: () => NOW,
    applicationsFor: () => Promise.resolve([{ id: APP, name: 'Acme CRM' }]),
    notify: () => undefined,
  })
  await auth.save(tokenResponse())
  const connection = await vault.readConnection()
  await vault.writeSites(connection?.workspace.id ?? '', [CRM])
  await vault.writePages({ [String(TAB)]: { origin: CRM, documentId: DOC } })

  /** One side panel: its own channel to the worker, which dies with it. */
  function panel(options: { localDelayMs?: number } = {}) {
    let alive = true
    const held = new Map<Method, ReturnType<typeof deferred<undefined>>[]>()
    const counts = new Map<Method, number>()
    const plain = <T>(value: T): T =>
      value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)

    /** Sent now (or never, once the panel is gone), handled later, in order. */
    function send<T>(method: Method, handle: () => Promise<T>): Promise<T> {
      if (!alive) return new Promise<T>(() => undefined)
      counts.set(method, (counts.get(method) ?? 0) + 1)
      return (async () => {
        await Promise.resolve()
        const answer = await handle()
        const gate = held.get(method)?.shift()
        if (gate) await gate.promise
        return plain(answer)
      })()
    }
    const result = <T>(data: Promise<T>) =>
      data.then((value): MessageResult<T> => ({ ok: true, data: value }))

    const client: AuthoringClient = {
      attach: (tabId) => send('attach', () => authoring.attach(tabId)),
      state: (panelId) => send('state', () => result(authoring.state(panelId))),
      guides: (panelId, applicationId) =>
        send('guides', () => authoring.guides(panelId, applicationId)),
      open: (panelId, applicationId, guideId) =>
        send('open', () => authoring.open(panelId, applicationId, guideId)),
      create: (panelId, applicationId, title) =>
        send('create', () => authoring.create(panelId, applicationId, title)),
      resume: (panelId) => send('resume', () => authoring.resume(panelId)),
      startCapture: (panelId) => send('startCapture', () => authoring.startCapture(panelId)),
      cancelCapture: (panelId) => send('cancelCapture', () => authoring.cancelCapture(panelId)),
      takeCapture: (panelId, captureId) =>
        send('takeCapture', () => authoring.takeCapture(panelId, captureId)),
      save: (panelId, operationId, applicationId, guideId, request) =>
        send('save', () =>
          authoring.save(panelId, operationId, applicationId, guideId, plain(request)),
        ),
      writeLocal: (panelId, draft, version) =>
        send('writeLocal', () => authoring.writeLocal(panelId, plain(draft), version)),
      clearLocal: (panelId, guideId, version) =>
        send('clearLocal', () => authoring.clearLocal(panelId, guideId, version)),
      showPreview: (panelId, captureId, title, lines) =>
        send('showPreview', () => authoring.showPreview(panelId, captureId, title, lines)),
      hidePreview: (panelId) => send('hidePreview', () => authoring.hidePreview(panelId)),
      exit: (panelId, final) => send('exit', () => authoring.exit(panelId, plain(final))),
      detach: (panelId, final) => {
        void send('detach', () => authoring.detach(panelId, plain(final)))
      },
    }
    const editMode = createEditMode({
      client,
      tabId: TAB,
      ...(options.localDelayMs !== undefined && { localDelayMs: options.localDelayMs }),
    })
    return {
      editMode,
      state: editMode.state,
      /** How many `method` messages this panel has sent. */
      count: (method: Method) => counts.get(method) ?? 0,
      /** Holds the answer to the next call of `method` until released. */
      holdNextAnswer(method: Method) {
        const gate = deferred<undefined>()
        held.set(method, [...(held.get(method) ?? []), gate])
        return () => {
          gate.resolve(undefined)
        }
      },
      /** What `App.vue` does on `pagehide`, then the page is gone. */
      close() {
        editMode.close()
        alive = false
      },
      async open() {
        await editMode.attach()
        await editMode.openGuide(GUIDE)
      },
      title(text: string) {
        const [first] = editMode.state.steps
        if (!first) throw new Error('no step')
        editMode.setTitle(first.key, text)
      },
    }
  }

  return {
    vault,
    sent,
    panel,
    authoring,
    /** Disconnect as the connection manager does it: one transition. */
    disconnect: () =>
      lifecycle.exclusive(async () => {
        lifecycle.invalidateCredentials()
        await vault.clearConnection(false, NOW)
      }),
    /** The worker has ended the session the panel had. */
    ended: () =>
      vi.waitFor(async () => {
        expect(await vault.readAuthoring()).toBeUndefined()
      }),
    /** A new panel opened on the same tab and guide: what it offers back. */
    reopen: async () => {
      const next = panel({ localDelayMs: 0 })
      await next.open()
      return next.state.recovery?.steps.map((step) => step.title) ?? null
    },
  }
}

describe('closing the side panel', () => {
  it('keeps the last edit when an earlier copy is still waiting for its answer', async () => {
    const { panel, ended, reopen } = await world()
    const first = panel({ localDelayMs: 0 })
    await first.open()
    first.title('Version A')
    await vi.waitFor(() => {
      expect(first.state.local).toBe('kept')
    })
    const releaseB = first.holdNextAnswer('writeLocal')
    first.title('Version B')
    // Version B's copy is sent; its answer is held back.
    await vi.waitFor(() => {
      expect(first.count('writeLocal')).toBe(2)
    })
    first.title('Version C')

    first.close()
    await ended()
    releaseB()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await reopen()).toEqual(['Version C'])
  })

  it('keeps an edit made just before the close, inside the quiet time', async () => {
    const { panel, ended, reopen } = await world()
    const first = panel({ localDelayMs: 600 })
    await first.open()
    first.title('Typed right before closing')

    first.close()
    await ended()

    expect(await reopen()).toEqual(['Typed right before closing'])
  })

  it('offers nothing new when the copy was already confirmed, and removes the picker', async () => {
    const { panel, ended, reopen, sent } = await world()
    const first = panel({ localDelayMs: 0 })
    await first.open()
    first.title('Confirmed copy')
    await vi.waitFor(() => {
      expect(first.state.local).toBe('kept')
    })
    const [step] = first.state.steps
    if (!step) throw new Error('no step')
    await first.editMode.startCapture(step.key)

    first.close()
    await ended()

    expect(sent.map((message) => message.type)).toContain('picker.stop')
    expect(await reopen()).toEqual(['Confirmed copy'])
  })

  it('keeps the last edit when Chrome reports the closed panel before the panel says so', async () => {
    const { panel, authoring, ended, reopen } = await world()
    const first = panel({ localDelayMs: 600 })
    await first.open()
    first.title('Typed while Chrome closed the panel')

    await authoring.panelClosed(TAB)
    first.close()
    await ended()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await reopen()).toEqual(['Typed while Chrome closed the panel'])
  })

  it('keeps nothing after Disconnect, whatever was still on its way', async () => {
    const { panel, vault, disconnect } = await world()
    const first = panel({ localDelayMs: 0 })
    await first.open()
    first.title('Private version A')
    await vi.waitFor(() => {
      expect(first.state.local).toBe('kept')
    })
    const releaseB = first.holdNextAnswer('writeLocal')
    first.title('Private version B')
    await vi.waitFor(() => {
      expect(first.count('writeLocal')).toBe(2)
    })
    first.title('Private version C')

    await disconnect()
    releaseB()
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(await vault.readDraft()).toBeUndefined()
  })

  it('keeps the last edit when the author exits right after typing', async () => {
    const { panel, reopen } = await world()
    const first = panel({ localDelayMs: 600 })
    await first.open()
    first.title('Typed right before Exit')

    await first.editMode.exit()
    first.close()

    expect(await reopen()).toEqual(['Typed right before Exit'])
  })
})
