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
const no = (code: 'CONFLICT' | 'STALE' | 'NOT_AVAILABLE', message: string) =>
  ({ ok: false, error: { code, message } }) as const

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
