import type { Guide, TargetDescriptor } from '@contextlayer/shared'
import { describe, expect, it, vi } from 'vitest'

import { captureTarget } from '../src/content/capture/descriptor'
import type { AuthoringStateData, MessageResult } from '../src/messaging/protocol'
import type { AuthoringClient } from '../src/sidepanel/client'
import { createEditMode } from '../src/sidepanel/edit-mode'
import { deferred } from './support/fakes'

const PANEL = 'Pn1_panel-id-0123456789abcdef'
const CAPTURE = 'Zk3_q-9xYt2LmN8pQ4rS'
const APP = '01a10a2e-864b-75bc-8800-aa3f01a05320'
const OTHER_APP = '01a10a2e-864b-75bc-8800-aa3f01a05321'
const GUIDE_A = '01a10a2e-864b-75bc-8800-aa3f01a05330'
const GUIDE_B = '01a10a2e-864b-75bc-8800-aa3f01a05331'
const STEP_A = '01a10a2e-864b-75bc-8800-aa3f01a05340'
const STEP_B = '01a10a2e-864b-75bc-8800-aa3f01a05341'

const ok = <T>(data: T): MessageResult<T> => ({ ok: true, data })
const no = (
  code: 'CONFLICT' | 'STALE' | 'NOT_AVAILABLE' | 'OUTCOME_UNKNOWN' | 'API_UNREACHABLE',
  message: string,
) => ({ ok: false, error: { code, message } }) as const

function guide(id: string, revision = 1, titles: string[] = []): Guide {
  return {
    id,
    applicationId: APP,
    title: id === GUIDE_A ? 'Create a customer' : 'Edit a customer',
    description: '',
    status: 'draft',
    revision,
    stepCount: titles.length,
    latestVersion: null,
    hasUnpublishedChanges: true,
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
    archivedAt: null,
    startUrlPattern: null,
    steps: titles.map((title, position) => ({
      id: [STEP_A, STEP_B][position] ?? crypto.randomUUID(),
      position,
      title,
      body: { version: 1, blocks: [] },
      target: null,
      urlPattern: null,
      placement: 'auto',
    })),
  }
}

function descriptor(): TargetDescriptor {
  document.body.innerHTML = '<button data-testid="save-customer">Save customer</button>'
  const button = document.querySelector('button')
  if (!button) throw new Error('no button')
  const outcome = captureTarget(button, {
    extensionVersion: '0.1.0',
    capturedAt: new Date(),
    href: 'https://crm.acme.test/customers',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.descriptor
}

const active = (capture: Extract<AuthoringStateData, { state: 'active' }>['capture'] = null) =>
  ok<AuthoringStateData>({ state: 'active', paused: null, guide: null, capture })

/** A worker that answers immediately, unless a test replaces a method. */
function fakeClient(applications = [{ id: APP, name: 'Acme CRM' }]) {
  const client = {
    attach: vi.fn<AuthoringClient['attach']>(() =>
      Promise.resolve(
        ok({
          panelId: PANEL,
          workspace: { id: 'w', name: 'Acme' },
          user: { displayName: 'Alice' },
          origin: 'https://crm.acme.test',
          applications,
        }),
      ),
    ),
    state: vi.fn<AuthoringClient['state']>(() => Promise.resolve(active())),
    guides: vi.fn<AuthoringClient['guides']>(() =>
      Promise.resolve(ok({ items: [guide(GUIDE_A), guide(GUIDE_B)] })),
    ),
    open: vi.fn<AuthoringClient['open']>((_panel, _app, guideId) =>
      Promise.resolve(ok({ guide: guide(guideId, 1, ['Open the form']), local: null })),
    ),
    create: vi.fn<AuthoringClient['create']>(() =>
      Promise.resolve(ok({ guide: guide(GUIDE_B), local: null })),
    ),
    resume: vi.fn<AuthoringClient['resume']>(() => Promise.resolve(ok({ done: true }))),
    startCapture: vi.fn<AuthoringClient['startCapture']>(() =>
      Promise.resolve(ok({ captureId: CAPTURE })),
    ),
    cancelCapture: vi.fn<AuthoringClient['cancelCapture']>(() =>
      Promise.resolve(ok({ done: true })),
    ),
    takeCapture: vi.fn<AuthoringClient['takeCapture']>(() =>
      Promise.resolve(
        ok({ id: CAPTURE, state: 'done' as const, descriptor: descriptor(), reason: null }),
      ),
    ),
    save: vi.fn<AuthoringClient['save']>((_panel, operationId) =>
      Promise.resolve(ok({ operationId, guide: guide(GUIDE_A, 2, ['Open the form', 'Save']) })),
    ),
    writeLocal: vi.fn<AuthoringClient['writeLocal']>(() =>
      Promise.resolve(ok({ stored: true, reason: null })),
    ),
    clearLocal: vi.fn<AuthoringClient['clearLocal']>(() => Promise.resolve(ok({ done: true }))),
    showPreview: vi.fn<AuthoringClient['showPreview']>(() => Promise.resolve(ok({ shown: true }))),
    hidePreview: vi.fn<AuthoringClient['hidePreview']>(() => Promise.resolve(ok({ done: true }))),
    exit: vi.fn<AuthoringClient['exit']>(() => Promise.resolve(ok({ done: true }))),
    detach: vi.fn<AuthoringClient['detach']>(),
  } satisfies AuthoringClient
  return client
}

async function opened(client = fakeClient()) {
  let operation = 0
  const editMode = createEditMode({
    client,
    tabId: 4,
    localDelayMs: 0,
    now: () => Date.parse('2026-10-05T12:30:00.000Z'),
    operationId: () => `op-${String(++operation).padStart(6, '0')}`,
  })
  await editMode.attach()
  await editMode.openGuide(GUIDE_A)
  return { editMode, client, state: editMode.state }
}

describe('Edit Mode in the side panel', () => {
  it('attaches to its tab and lists the guides of the only application', async () => {
    const client = fakeClient()
    const editMode = createEditMode({ client, tabId: 4 })

    await editMode.attach()

    expect(client.attach).toHaveBeenCalledWith(4)
    expect(editMode.state.phase).toBe('ready')
    expect(editMode.state.applicationId).toBe(APP)
    expect(editMode.state.guides?.map((item) => item.id)).toEqual([GUIDE_A, GUIDE_B])
  })

  it('asks which application when several share the origin', async () => {
    const client = fakeClient([
      { id: APP, name: 'Acme CRM' },
      { id: OTHER_APP, name: 'Acme CRM (beta)' },
    ])
    const editMode = createEditMode({ client, tabId: 4 })

    await editMode.attach()
    expect(editMode.state.applicationId).toBeNull()
    expect(client.guides).not.toHaveBeenCalled()

    await editMode.chooseApplication(OTHER_APP)
    expect(client.guides).toHaveBeenCalledWith(PANEL, OTHER_APP)
  })

  it('explains why Edit Mode is not available', async () => {
    const client = fakeClient()
    client.attach.mockResolvedValueOnce(
      no('NOT_AVAILABLE', 'ContextLayer is not active on this page.'),
    )
    const editMode = createEditMode({ client, tabId: 4 })

    await editMode.attach()

    expect(editMode.state).toMatchObject({
      phase: 'unavailable',
      unavailable: 'ContextLayer is not active on this page.',
    })
    const withoutTab = createEditMode({ client, tabId: undefined })
    await withoutTab.attach()
    expect(withoutTab.state.unavailable).toBe('Open Edit Mode from the ContextLayer popup.')
  })

  it('keeps the guide picked last when an earlier one loads late', async () => {
    const client = fakeClient()
    const slow = deferred<Awaited<ReturnType<AuthoringClient['open']>>>()
    client.open.mockImplementationOnce(() => slow.promise)
    const editMode = createEditMode({ client, tabId: 4 })
    await editMode.attach()

    const first = editMode.openGuide(GUIDE_A)
    await editMode.openGuide(GUIDE_B)
    slow.resolve(ok({ guide: guide(GUIDE_A), local: null }))
    await first

    expect(editMode.state.guide?.id).toBe(GUIDE_B)
  })

  it('saves the steps with the revision they were based on and keeps the ids it gets', async () => {
    const { editMode, client, state } = await opened()
    const key = editMode.addStep()
    editMode.setTitle(key, ' Save ')
    expect(editMode.dirty.value).toBe(true)

    await editMode.save()

    expect(client.save).toHaveBeenCalledWith(PANEL, 'op-000001', APP, GUIDE_A, {
      expectedRevision: 1,
      steps: [
        expect.objectContaining({ id: STEP_A, title: 'Open the form' }),
        expect.not.objectContaining({ id: expect.anything() }),
      ],
    })
    expect(state.steps.map((step) => step.id)).toEqual([STEP_A, STEP_B])
    expect(state.baseRevision).toBe(2)
    expect(editMode.dirty.value).toBe(false)
    expect(state.lastSavedAt).toBe(Date.parse('2026-10-05T12:30:00.000Z'))
  })

  it('does not mark edits made while saving as saved', async () => {
    const { editMode, client, state } = await opened()
    const slow = deferred<Awaited<ReturnType<AuthoringClient['save']>>>()
    client.save.mockImplementationOnce(() => slow.promise)
    const [first] = state.steps
    if (!first) throw new Error('no step')
    editMode.setTitle(first.key, 'Open the customer form')

    const saving = editMode.save()
    editMode.setTitle(first.key, 'Open the new customer form')
    await editMode.save()
    slow.resolve(
      ok({ operationId: 'op-000001', guide: guide(GUIDE_A, 2, ['Open the customer form']) }),
    )
    await saving

    expect(client.save).toHaveBeenCalledOnce()
    expect(editMode.dirty.value).toBe(true)
    expect(state.status).toBe('Saved. Changes made while saving are not saved yet.')
    expect(state.steps[0]?.title).toBe('Open the new customer form')
  })

  it('never saves steps the API would refuse', async () => {
    const { editMode, client, state } = await opened()
    editMode.addStep()

    await editMode.save()

    expect(client.save).not.toHaveBeenCalled()
    expect(state.showProblems).toBe(true)
    expect(editMode.problems.value.size).toBe(1)
  })

  it('keeps the edits and says so when the guide changed elsewhere', async () => {
    const { editMode, client, state } = await opened()
    client.save.mockResolvedValueOnce(
      no('CONFLICT', 'This guide was changed somewhere else. Load the latest draft before saving.'),
    )
    editMode.addStep()
    const [, added] = state.steps
    if (!added) throw new Error('no step')
    editMode.setTitle(added.key, 'Save')

    await editMode.save()

    expect(state.conflict).toBe(true)
    expect(state.baseRevision).toBe(1)
    expect(editMode.dirty.value).toBe(true)
    expect(state.steps).toHaveLength(2)
  })

  it('offers a captured element for review and applies it only when the author accepts', async () => {
    const { editMode, client, state } = await opened()
    const [first] = state.steps
    if (!first) throw new Error('no step')

    await editMode.startCapture(first.key)
    expect(state.capture).toEqual({ stepKey: first.key, captureId: CAPTURE })
    client.state.mockResolvedValueOnce(active({ id: CAPTURE, state: 'done', reason: null }))
    await editMode.refresh()

    expect(state.capture).toBeNull()
    expect(state.review?.stepKey).toBe(first.key)
    expect(state.steps[0]?.target).toBeNull()
    expect(editMode.dirty.value).toBe(false)

    editMode.acceptReview()
    expect(state.steps[0]?.target).toMatchObject({ version: 1, element: { tag: 'button' } })
    expect(state.steps[0]?.captureId).toBe(CAPTURE)
    expect(editMode.dirty.value).toBe(true)
    expect(client.save).not.toHaveBeenCalled()
  })

  it('shows why nothing was captured', async () => {
    const { editMode, client, state } = await opened()
    const [first] = state.steps
    if (!first) throw new Error('no step')
    await editMode.startCapture(first.key)
    client.state.mockResolvedValueOnce(active({ id: CAPTURE, state: 'cancelled', reason: null }))
    client.takeCapture.mockResolvedValueOnce(
      ok({ id: CAPTURE, state: 'cancelled', descriptor: null, reason: 'Cancelled on the page.' }),
    )

    await editMode.refresh()

    expect(state.review).toBeNull()
    expect(state.captureNote).toEqual({ stepKey: first.key, text: 'Cancelled on the page.' })
  })

  it('cancels a selection in progress from the panel', async () => {
    const { editMode, client, state } = await opened()
    const [first] = state.steps
    if (!first) throw new Error('no step')
    await editMode.startCapture(first.key)

    await editMode.cancelCapture()

    expect(client.cancelCapture).toHaveBeenCalledWith(PANEL)
    expect(state.capture).toBeNull()
  })

  it('shows that Edit Mode ended, and why', async () => {
    const { editMode, client, state } = await opened()
    client.state.mockResolvedValueOnce(ok({ state: 'ended', reason: 'disconnected' }))

    await editMode.refresh()

    expect(state).toMatchObject({ phase: 'ended', endedReason: 'disconnected' })
  })

  it('reorders, deletes and removes targets as unsaved edits', async () => {
    const { editMode, state } = await opened()
    const key = editMode.addStep()
    editMode.setTitle(key, 'Save')

    editMode.moveStep(key, -1)
    expect(state.steps.map((step) => step.title)).toEqual(['Save', 'Open the form'])
    await editMode.removeStep(key)
    expect(state.steps.map((step) => step.title)).toEqual(['Open the form'])
    expect(editMode.dirty.value).toBe(true)
  })
})

describe('unsaved changes and lost answers', () => {
  const local = (baseRevision: number) => ({
    applicationId: APP,
    guideId: GUIDE_A,
    baseRevision,
    savedAt: Date.parse('2026-10-05T12:10:00.000Z'),
    steps: [
      {
        id: STEP_A,
        title: 'Open the form (kept)',
        body: { version: 1 as const, blocks: [] },
        target: null,
        urlPattern: null,
        placement: 'auto' as const,
      },
    ],
  })

  it('keeps a copy of the edits in the browser session, bound to the guide and its revision', async () => {
    const { editMode, client, state } = await opened()
    const [first] = state.steps
    if (!first) throw new Error('no step')

    editMode.setTitle(first.key, 'Open the customer form')

    await vi.waitFor(() => {
      expect(client.writeLocal).toHaveBeenCalledWith(
        PANEL,
        {
          applicationId: APP,
          guideId: GUIDE_A,
          baseRevision: 1,
          steps: [expect.objectContaining({ id: STEP_A, title: 'Open the customer form' })],
        },
        editMode.state.editVersion,
      )
    })
    await vi.waitFor(() => {
      expect(state.local).toBe('kept')
    })
  })

  it('says when the copy could not be kept', async () => {
    const { editMode, client, state } = await opened()
    client.writeLocal.mockResolvedValue(ok({ stored: false, reason: 'too-large' as const }))
    editMode.addStep()

    await vi.waitFor(() => {
      expect(state.local).toBe('too-large')
    })
  })

  it('drops the copy once a save confirmed every edit', async () => {
    const { editMode, client } = await opened()
    const key = editMode.addStep()
    editMode.setTitle(key, 'Save')

    await editMode.save()

    await vi.waitFor(() => {
      expect(client.clearLocal).toHaveBeenCalledWith(PANEL, GUIDE_A, expect.any(Number))
    })
  })

  it('offers a kept copy back and restores it on the revision it started from', async () => {
    const client = fakeClient()
    client.open.mockResolvedValueOnce(
      ok({ guide: guide(GUIDE_A, 1, ['Open the form']), local: local(1) }),
    )
    const { editMode, state } = await opened(client)

    expect(state.recovery?.savedAt).toBe(Date.parse('2026-10-05T12:10:00.000Z'))
    expect(state.steps[0]?.title).toBe('Open the form')
    editMode.restoreLocal()

    expect(state.steps[0]?.title).toBe('Open the form (kept)')
    expect(editMode.dirty.value).toBe(true)
    expect(state.conflict).toBe(false)
    expect(state.recovery).toBeNull()
  })

  it('restores an outdated copy as a conflict, never on the newer revision', async () => {
    const client = fakeClient()
    client.open.mockResolvedValueOnce(
      ok({ guide: guide(GUIDE_A, 3, ['Open the form']), local: local(1) }),
    )
    const { editMode, state } = await opened(client)

    editMode.restoreLocal()

    expect(state.baseRevision).toBe(1)
    expect(state.conflict).toBe(true)
  })

  it('discards a kept copy when asked', async () => {
    const client = fakeClient()
    client.open.mockResolvedValueOnce(
      ok({ guide: guide(GUIDE_A, 1, ['Open the form']), local: local(1) }),
    )
    const { editMode, state } = await opened(client)

    await editMode.discardLocal()

    expect(client.clearLocal).toHaveBeenCalledWith(PANEL, GUIDE_A, expect.any(Number))
    expect(state.recovery).toBeNull()
    expect(state.steps[0]?.title).toBe('Open the form')
  })

  it('replaces the edits with the latest version only when asked, after a conflict', async () => {
    const { editMode, client, state } = await opened()
    client.save.mockResolvedValueOnce(no('CONFLICT', 'Changed elsewhere.'))
    const [first] = state.steps
    if (!first) throw new Error('no step')
    editMode.setTitle(first.key, 'Mine')
    await editMode.save()
    expect(state.conflict).toBe(true)
    client.open.mockResolvedValueOnce(ok({ guide: guide(GUIDE_A, 4, ['Theirs']), local: null }))

    await editMode.loadLatest()

    expect(client.clearLocal).toHaveBeenCalledWith(PANEL, GUIDE_A, expect.any(Number))
    expect(state.steps[0]?.title).toBe('Theirs')
    expect(state.baseRevision).toBe(4)
    expect(state.conflict).toBe(false)
    expect(editMode.dirty.value).toBe(false)
  })

  describe('when a save answer is lost', () => {
    async function lost() {
      const context = await opened()
      context.client.save.mockResolvedValueOnce(no('OUTCOME_UNKNOWN', 'The answer was lost.'))
      const key = context.editMode.addStep()
      context.editMode.setTitle(key, 'Save')
      return context
    }

    it('reports it saved when the server has exactly what was sent, one revision later', async () => {
      const { editMode, client, state } = await lost()
      client.open.mockResolvedValueOnce(
        ok({ guide: guide(GUIDE_A, 2, ['Open the form', 'Save']), local: null }),
      )

      await editMode.save()

      expect(editMode.dirty.value).toBe(false)
      expect(state.steps.map((step) => step.id)).toEqual([STEP_A, STEP_B])
      expect(state.status).toBe('Your save reached ContextLayer.')
    })

    it('never claims more than the server shows, and never retries by itself', async () => {
      const { editMode, client, state } = await lost()
      client.open.mockResolvedValueOnce(
        ok({ guide: guide(GUIDE_A, 1, ['Open the form']), local: null }),
      )

      await editMode.save()

      expect(client.save).toHaveBeenCalledOnce()
      expect(editMode.dirty.value).toBe(true)
      expect(state.baseRevision).toBe(1)
      expect(state.status).toBe(
        'ContextLayer still has the version from before your save. Your changes are still here; save again when ready.',
      )
    })

    it('treats different content on the server as a conflict', async () => {
      const { editMode, client, state } = await lost()
      client.open.mockResolvedValueOnce(
        ok({ guide: guide(GUIDE_A, 2, ['Something else']), local: null }),
      )

      await editMode.save()

      expect(state.conflict).toBe(true)
      expect(editMode.dirty.value).toBe(true)
    })

    it('blocks saving until the server could be checked', async () => {
      const { editMode, client, state } = await lost()
      client.open.mockResolvedValueOnce(no('API_UNREACHABLE', 'The API could not be reached.'))

      await editMode.save()
      expect(state.unknownSave).toBe(true)
      await editMode.save()
      expect(client.save).toHaveBeenCalledOnce()

      client.open.mockResolvedValueOnce(
        ok({ guide: guide(GUIDE_A, 2, ['Open the form', 'Save']), local: null }),
      )
      await editMode.checkSave()
      expect(state.unknownSave).toBe(false)
      expect(editMode.dirty.value).toBe(false)
    })
  })
})

describe('previewing a step', () => {
  async function withTarget() {
    const context = await opened()
    const [first] = context.state.steps
    if (!first) throw new Error('no step')
    context.editMode.setInstructions(first.key, 'Fill in the name.\n\n- Name\n- Email')
    await context.editMode.startCapture(first.key)
    context.client.state.mockResolvedValueOnce(active({ id: CAPTURE, state: 'done', reason: null }))
    await context.editMode.refresh()
    context.editMode.acceptReview()
    return { ...context, key: first.key }
  }

  it('shows the step on the element selected on this page, as plain lines', async () => {
    const { editMode, client, state, key } = await withTarget()

    await editMode.preview(key)

    expect(client.showPreview).toHaveBeenCalledWith(PANEL, CAPTURE, 'Open the form', [
      'Fill in the name.',
      '• Name',
      '• Email',
    ])
    expect(state.preview).toBe(key)
    await editMode.hidePreview()
    expect(client.hidePreview).toHaveBeenCalledWith(PANEL)
    expect(state.preview).toBeNull()
  })

  it('asks for a new selection when the page no longer holds the element', async () => {
    const { editMode, client, state, key } = await withTarget()
    client.showPreview.mockResolvedValueOnce(ok({ shown: false }))

    await editMode.preview(key)

    expect(state.preview).toBeNull()
    expect(state.previewNote).toEqual({
      stepKey: key,
      text: 'This element is no longer on the page. Select it again to preview this step.',
    })
  })

  it('never looks up a target that was not selected on this page', async () => {
    const client = fakeClient()
    const saved = guide(GUIDE_A, 1, ['Saved before'])
    client.open.mockResolvedValueOnce(
      ok({
        guide: { ...saved, steps: saved.steps.map((item) => ({ ...item, target: descriptor() })) },
        local: null,
      }),
    )
    const { editMode, state } = await opened(client)
    const [first] = state.steps
    if (!first) throw new Error('no step')

    await editMode.preview(first.key)

    expect(client.showPreview).not.toHaveBeenCalled()
    expect(state.previewNote?.text).toBe(
      'Select the element again on this page to preview this step.',
    )
  })
})

describe('what the panel says about the local copy', () => {
  const stored = ok({ stored: true, reason: null })

  it('says pending, not kept, for an edit made after the last confirmed copy', async () => {
    const { editMode, client, state } = await opened()
    const [first] = state.steps
    if (!first) throw new Error('no step')
    editMode.setTitle(first.key, 'Version A')
    await vi.waitFor(() => {
      expect(state.local).toBe('kept')
    })
    const slow = deferred<Awaited<ReturnType<AuthoringClient['writeLocal']>>>()
    client.writeLocal.mockImplementationOnce(() => slow.promise)

    editMode.setTitle(first.key, 'Version B')

    expect(state.local).toBe('pending')
    slow.resolve(stored)
    await vi.waitFor(() => {
      expect(state.local).toBe('kept')
    })
  })

  it('never lets an old acknowledgement mark a newer edit as kept', async () => {
    const { editMode, client, state } = await opened()
    const [first] = state.steps
    if (!first) throw new Error('no step')
    const answers = [
      deferred<Awaited<ReturnType<AuthoringClient['writeLocal']>>>(),
      deferred<Awaited<ReturnType<AuthoringClient['writeLocal']>>>(),
    ]
    client.writeLocal
      .mockImplementationOnce(() => answers[0]?.promise ?? Promise.resolve(stored))
      .mockImplementationOnce(() => answers[1]?.promise ?? Promise.resolve(stored))

    editMode.setTitle(first.key, 'Version B')
    await vi.waitFor(() => {
      expect(client.writeLocal).toHaveBeenCalledTimes(1)
    })
    editMode.setTitle(first.key, 'Version C')
    answers[0]?.resolve(stored)
    await vi.waitFor(() => {
      expect(client.writeLocal).toHaveBeenCalledTimes(2)
    })

    // Version B was confirmed, but the panel shows Version C.
    expect(state.local).toBe('pending')
    answers[1]?.resolve(stored)
    await vi.waitFor(() => {
      expect(state.local).toBe('kept')
    })
  })

  it('keeps edits made during a save on the new revision', async () => {
    const { editMode, client, state } = await opened()
    const [first] = state.steps
    if (!first) throw new Error('no step')
    editMode.setTitle(first.key, 'Sent with the save')
    const saving = deferred<Awaited<ReturnType<AuthoringClient['save']>>>()
    client.save.mockImplementationOnce(() => saving.promise)

    const done = editMode.save()
    editMode.setTitle(first.key, 'Typed during the save')
    await vi.waitFor(() => {
      expect(state.local).toBe('kept')
    })
    saving.resolve(
      ok({ operationId: 'op-000001', guide: guide(GUIDE_A, 2, ['Sent with the save']) }),
    )
    await done

    await vi.waitFor(() => {
      expect(client.writeLocal.mock.lastCall?.[1]).toMatchObject({
        baseRevision: 2,
        steps: [expect.objectContaining({ title: 'Typed during the save' })],
      })
    })
    await vi.waitFor(() => {
      expect(state.local).toBe('kept')
    })
  })
})
