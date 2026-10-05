import type { Guide, GuideSummary, StepInput, TargetDescriptor } from '@contextlayer/shared'
import { computed, reactive } from 'vue'

import type {
  AuthoringAttachData,
  AuthoringStateData,
  LocalDraft,
  MessageError,
} from '../messaging/protocol'
import type { AuthoringClient } from './client'
import {
  assignSavedIds,
  fromGuide,
  fromLocal,
  move,
  newStep,
  richTextLines,
  sameSteps,
  stepProblems,
  toDraft,
  toStepInputs,
  withInstructions,
  type EditorStep,
} from './draft'

/**
 * Edit Mode as the side panel sees it: the session, the open guide, its steps
 * as edited here, the capture in progress and the save state. The view
 * (`App.vue`) only renders this and calls its actions.
 *
 * Three kinds of state are kept apart: what is only in this panel's memory
 * (`dirty`), the copy the worker keeps in the browser session (`local`, lost
 * when the browser closes, offered back as `recovery`), and what the server
 * confirmed (`guide`, `lastSavedAt`). A captured element is never applied by
 * itself: it waits in `review` until the author uses it, and nothing reaches
 * the server until the author saves. A save whose answer was lost is checked
 * against the server before anything is claimed, and never retried by
 * itself; the revision is never bumped to get past a conflict.
 */

export type EndReason = Extract<AuthoringStateData, { state: 'ended' }>['reason']

export interface EditModeDeps {
  client: AuthoringClient
  /** The tab the panel was opened for (`sidepanel.html?tab=…`). */
  tabId: number | undefined
  now?: () => number
  /** Ids for save operations; replaced in tests. */
  operationId?: () => string
  /** Quiet time after an edit before the local copy is written (default 600 ms). */
  localDelayMs?: number
}

export interface EditModeState {
  phase: 'attaching' | 'unavailable' | 'ready' | 'ended'
  /** Why Edit Mode is unavailable here. */
  unavailable: string
  endedReason: EndReason | null
  info: AuthoringAttachData | null
  paused: 'navigated' | 'page-gone' | null
  applicationId: string | null
  guides: GuideSummary[] | null
  guidesError: string | null
  /** The server's copy as last loaded or saved. */
  guide: Guide | null
  /** The revision the edits are based on, sent back as `expectedRevision`. */
  baseRevision: number | null
  steps: EditorStep[]
  /** Bumped on every edit; `savedVersion` is the edit a confirmed save included. */
  editVersion: number
  savedVersion: number
  loading: boolean
  saving: boolean
  conflict: boolean
  lastSavedAt: number | null
  showProblems: boolean
  /** Polite announcements for screen readers. */
  status: string
  error: string | null
  capture: { stepKey: string; captureId: string } | null
  review: { stepKey: string; captureId: string; descriptor: TargetDescriptor } | null
  captureNote: { stepKey: string; text: string } | null
  /** The copy in the browser session: kept, or why not. */
  local: 'none' | 'kept' | 'too-large' | 'quota' | 'failed'
  /** A copy found when the guide was opened, offered back to the author. */
  recovery: LocalDraft | null
  /** A save was sent, its answer was lost, and the server could not be checked yet. */
  unknownSave: boolean
  /** The step previewed on the page. */
  preview: string | null
  previewNote: { stepKey: string; text: string } | null
}

export function createEditMode(deps: EditModeDeps) {
  const { client } = deps
  const now = deps.now ?? (() => Date.now())
  const operationId = deps.operationId ?? (() => crypto.randomUUID())

  const state = reactive<EditModeState>({
    phase: 'attaching',
    unavailable: '',
    endedReason: null,
    info: null,
    paused: null,
    applicationId: null,
    guides: null,
    guidesError: null,
    guide: null,
    baseRevision: null,
    steps: [],
    editVersion: 0,
    savedVersion: 0,
    loading: false,
    saving: false,
    conflict: false,
    lastSavedAt: null,
    showProblems: false,
    status: '',
    error: null,
    capture: null,
    review: null,
    captureNote: null,
    local: 'none',
    recovery: null,
    unknownSave: false,
    preview: null,
    previewNote: null,
  })

  let panelId: string | undefined
  let loadToken = 0
  let refreshing: Promise<void> | undefined
  let refreshAgain = false
  /** Read through a call: it changes while `runRefresh` awaits. */
  const again = () => refreshAgain

  const dirty = computed(() => state.editVersion !== state.savedVersion)
  const problems = computed(() => stepProblems(state.steps))

  // The local copy: one write or clear at a time, in order, coalesced.
  let localTimer: ReturnType<typeof setTimeout> | undefined
  let localChain: Promise<void> = Promise.resolve()
  /** A save whose answer was lost, to check against the server. */
  let pendingCheck:
    | { guideId: string; base: number; version: number; sent: EditorStep[]; inputs: StepInput[] }
    | undefined

  function queueLocal(task: () => Promise<void>): Promise<void> {
    localChain = localChain.then(task, task)
    return localChain
  }

  function writeLocalNow(): Promise<void> {
    clearTimeout(localTimer)
    localTimer = undefined
    const guide = state.guide
    const applicationId = state.applicationId
    const baseRevision = state.baseRevision
    const id = panelId
    if (!id || !guide || !applicationId || baseRevision === null) return Promise.resolve()
    const draft = { applicationId, guideId: guide.id, baseRevision, steps: toDraft(state.steps) }
    return queueLocal(async () => {
      const result = await client.writeLocal(id, draft)
      if (state.guide?.id !== guide.id) return
      if (!result.ok) state.local = 'failed'
      else state.local = result.data.stored ? 'kept' : (result.data.reason ?? 'failed')
    })
  }

  function clearLocalNow(guideId: string): Promise<void> {
    clearTimeout(localTimer)
    localTimer = undefined
    const id = panelId
    if (!id) return Promise.resolve()
    return queueLocal(async () => {
      await client.clearLocal(id, guideId)
      if (state.guide?.id === guideId && !dirty.value) state.local = 'none'
    })
  }

  function touch() {
    state.editVersion += 1
    clearTimeout(localTimer)
    localTimer = setTimeout(() => {
      void writeLocalNow()
    }, deps.localDelayMs ?? 600)
  }

  function fail(error: MessageError) {
    state.error = error.message
    if (error.code === 'STALE') void refresh()
  }

  function applyGuide(guide: Guide, local: LocalDraft | null = null) {
    clearTimeout(localTimer)
    localTimer = undefined
    pendingCheck = undefined
    state.unknownSave = false
    state.local = 'none'
    state.recovery = local
    state.guide = guide
    state.baseRevision = guide.revision
    state.steps = fromGuide(guide)
    state.editVersion = 0
    state.savedVersion = 0
    state.conflict = false
    state.review = null
    state.captureNote = null
    state.lastSavedAt = null
    state.showProblems = false
    state.error = null
  }

  async function loadGuides() {
    if (!panelId || !state.applicationId) return
    state.guides = null
    state.guidesError = null
    const result = await client.guides(panelId, state.applicationId)
    if (result.ok) state.guides = result.data.items
    else state.guidesError = result.error.message
  }

  async function load(
    request: (id: string, applicationId: string) => ReturnType<AuthoringClient['open']>,
  ) {
    if (!panelId || !state.applicationId) return
    const token = ++loadToken
    state.loading = true
    state.error = null
    const result = await request(panelId, state.applicationId)
    // A newer load started meanwhile: this answer is not the guide on screen.
    if (token !== loadToken) return
    state.loading = false
    if (!result.ok) {
      fail(result.error)
      return
    }
    if (state.capture) await cancelCapture()
    applyGuide(result.data.guide, result.data.local)
    state.status = `Editing “${result.data.guide.title}”.`
  }

  /** The server confirmed a save that included the edits up to `version`. */
  function applySaved(guide: Guide, sent: readonly EditorStep[], version: number) {
    state.guide = guide
    state.baseRevision = guide.revision
    state.steps = assignSavedIds(state.steps, sent, guide)
    state.savedVersion = version
    state.lastSavedAt = now()
    state.conflict = false
    state.error = null
    // Edits made while saving are still only here: keep their copy, on the new revision.
    void (dirty.value ? writeLocalNow() : clearLocalNow(guide.id))
  }

  /**
   * A save's answer was lost: read the guide again and decide from what the
   * server has, never from a guess. Exactly what was sent, one revision
   * later: saved. The revision it was based on: not applied (yet). Anything
   * else: someone else changed it, so it is a conflict.
   */
  async function checkSave() {
    const check = pendingCheck
    if (!check || !panelId || !state.applicationId) return
    state.status = 'Checking whether your save reached ContextLayer…'
    const result = await client.open(panelId, state.applicationId, check.guideId)
    if (state.guide?.id !== check.guideId) return
    if (!result.ok) {
      state.unknownSave = true
      state.error = `The answer to your save was lost and the guide could not be checked: ${result.error.message} Your changes are still here; check again before saving.`
      return
    }
    pendingCheck = undefined
    state.unknownSave = false
    const server = result.data.guide
    if (server.revision === check.base + 1 && sameSteps(server.steps, check.inputs)) {
      applySaved(server, check.sent, check.version)
      state.status = 'Your save reached ContextLayer.'
      return
    }
    state.error = null
    if (server.revision === check.base) {
      state.status =
        'ContextLayer still has the version from before your save. Your changes are still here; save again when ready.'
      return
    }
    state.conflict = true
    state.status =
      'The guide changed on ContextLayer, and not exactly as your save would have changed it. Your changes are still here.'
  }

  function step(key: string): EditorStep | undefined {
    return state.steps.find((candidate) => candidate.key === key)
  }

  function replaceStep(key: string, change: (step: EditorStep) => EditorStep) {
    state.steps = state.steps.map((candidate) =>
      candidate.key === key ? change(candidate) : candidate,
    )
    touch()
  }

  async function takeCapture(capture: { stepKey: string; captureId: string }) {
    if (!panelId) return
    const taken = await client.takeCapture(panelId, capture.captureId)
    if (!step(capture.stepKey)) return
    if (taken.ok && taken.data.state === 'done' && taken.data.descriptor) {
      state.review = {
        stepKey: capture.stepKey,
        captureId: capture.captureId,
        descriptor: taken.data.descriptor,
      }
      state.status = 'Element selected. Review it before using it.'
    } else {
      const text = taken.ok
        ? (taken.data.reason ?? 'No element was selected.')
        : taken.error.message
      state.captureNote = { stepKey: capture.stepKey, text }
      state.status = text
    }
  }

  async function runRefresh() {
    if (!panelId) return
    do {
      refreshAgain = false
      const result = await client.state(panelId)
      if (!result.ok) continue
      const data = result.data
      if (data.state === 'ended') {
        state.phase = 'ended'
        state.endedReason = data.reason
        state.capture = null
        return
      }
      state.paused = data.paused
      const capture = state.capture
      if (capture && data.capture?.id === capture.captureId) {
        if (data.capture.state !== 'pending') {
          state.capture = null
          await takeCapture(capture)
        }
      } else if (capture) {
        // Replaced or dropped by the worker (another guide, a reload).
        state.capture = null
      }
    } while (again())
  }

  /** Called on `authoring.changed`: asks the worker what changed. */
  function refresh(): Promise<void> {
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    refreshing = runRefresh().finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  async function cancelCapture() {
    const capture = state.capture
    state.capture = null
    if (panelId && capture) await client.cancelCapture(panelId)
  }

  return {
    state,
    dirty,
    problems,
    step,

    async attach() {
      if (deps.tabId === undefined) {
        state.phase = 'unavailable'
        state.unavailable = 'Open Edit Mode from the ContextLayer popup.'
        return
      }
      state.phase = 'attaching'
      const result = await client.attach(deps.tabId)
      if (!result.ok) {
        state.phase = 'unavailable'
        state.unavailable = result.error.message
        return
      }
      panelId = result.data.panelId
      state.info = result.data
      state.phase = 'ready'
      const [only, ...others] = result.data.applications
      if (only && others.length === 0) {
        state.applicationId = only.id
        await loadGuides()
      }
    },

    refresh,

    async chooseApplication(applicationId: string) {
      if (!state.info?.applications.some((application) => application.id === applicationId)) return
      state.applicationId = applicationId
      await loadGuides()
    },

    loadGuides,

    openGuide: (guideId: string) =>
      load((id, applicationId) => client.open(id, applicationId, guideId)),

    createGuide: (title: string) =>
      load((id, applicationId) => client.create(id, applicationId, title.trim())),

    /** Back to the guide list; the view confirms first when there are unsaved changes. */
    async closeGuide() {
      loadToken += 1
      if (state.capture) await cancelCapture()
      // Leaving the guide discards its unsaved changes, including their copy.
      if (state.guide && dirty.value) await clearLocalNow(state.guide.id)
      clearTimeout(localTimer)
      localTimer = undefined
      pendingCheck = undefined
      state.unknownSave = false
      state.recovery = null
      state.local = 'none'
      state.guide = null
      state.baseRevision = null
      state.steps = []
      state.editVersion = 0
      state.savedVersion = 0
      state.review = null
      state.conflict = false
      state.error = null
      await loadGuides()
    },

    addStep(): string {
      const created = newStep()
      state.steps = [...state.steps, created]
      touch()
      return created.key
    },

    async removeStep(key: string) {
      if (state.capture?.stepKey === key) await cancelCapture()
      if (state.review?.stepKey === key) state.review = null
      state.steps = state.steps.filter((candidate) => candidate.key !== key)
      touch()
    },

    moveStep(key: string, delta: -1 | 1) {
      const index = state.steps.findIndex((candidate) => candidate.key === key)
      state.steps = move(state.steps, index, delta)
      touch()
    },

    setTitle(key: string, title: string) {
      replaceStep(key, (current) => ({ ...current, title }))
    },

    setInstructions(key: string, text: string) {
      if (step(key)?.instructions === null) return
      replaceStep(key, (current) => withInstructions(current, text))
    },

    removeTarget(key: string) {
      replaceStep(key, (current) => ({ ...current, target: null, captureId: null }))
      state.status = 'Target removed.'
    },

    async startCapture(key: string) {
      if (!panelId || !step(key)) return
      if (state.capture) await cancelCapture()
      // The page hides a preview when a selection starts.
      state.preview = null
      state.previewNote = null
      state.review = null
      state.captureNote = null
      const result = await client.startCapture(panelId)
      if (!result.ok) {
        state.captureNote = { stepKey: key, text: result.error.message }
        if (result.error.code === 'PAGE_CHANGED' || result.error.code === 'STALE') await refresh()
        return
      }
      state.capture = { stepKey: key, captureId: result.data.captureId }
      state.status = 'Click the element on the page. Press Esc on the page to cancel.'
    },

    cancelCapture,

    /**
     * Shows the step on the page, on the element selected there for it. A
     * step whose element was not selected on this page (loaded from the
     * server, or the page reloaded since) cannot be previewed: it is never
     * looked up, the author selects it again.
     */
    async preview(key: string) {
      const current = step(key)
      if (!panelId || !current) return
      state.previewNote = null
      if (!current.target || !current.captureId) {
        state.previewNote = {
          stepKey: key,
          text: 'Select the element again on this page to preview this step.',
        }
        return
      }
      if (state.capture) await cancelCapture()
      const result = await client.showPreview(
        panelId,
        current.captureId,
        current.title,
        richTextLines(current.body),
      )
      if (!result.ok) {
        state.previewNote = { stepKey: key, text: result.error.message }
        if (result.error.code === 'PAGE_CHANGED' || result.error.code === 'STALE') await refresh()
        return
      }
      if (!result.data.shown) {
        state.preview = null
        state.previewNote = {
          stepKey: key,
          text: 'This element is no longer on the page. Select it again to preview this step.',
        }
        return
      }
      state.preview = key
      state.status = 'Previewing the step on the page.'
    },

    async hidePreview() {
      state.preview = null
      if (panelId) await client.hidePreview(panelId)
    },

    /** The author accepts the reviewed element for its step (still unsaved). */
    acceptReview() {
      const review = state.review
      if (!review) return
      state.review = null
      replaceStep(review.stepKey, (current) => ({
        ...current,
        target: review.descriptor,
        captureId: review.captureId,
      }))
      state.status = 'Target set. Save to keep it.'
    },

    discardReview() {
      state.review = null
      state.status = 'Selection discarded.'
    },

    async resume() {
      if (!panelId) return
      const result = await client.resume(panelId)
      if (result.ok) {
        state.paused = null
        state.status = 'Continuing on this page.'
      } else {
        state.error = result.error.message
      }
    },

    async save() {
      const guide = state.guide
      if (!panelId || !guide || !state.applicationId || state.baseRevision === null) return
      if (state.saving) return
      if (problems.value.size > 0) {
        state.showProblems = true
        state.status = 'Fix the highlighted steps before saving.'
        return
      }
      if (state.unknownSave) {
        state.status = 'Check whether your last save reached ContextLayer first.'
        return
      }
      const sent = [...state.steps]
      const sentVersion = state.editVersion
      const base = state.baseRevision
      const inputs = toStepInputs(sent)
      const id = operationId()
      state.saving = true
      state.error = null
      state.status = 'Saving…'
      const result = await client.save(panelId, id, state.applicationId, guide.id, {
        expectedRevision: base,
        steps: inputs,
      })
      state.saving = false
      // Another guide was opened while saving: this answer is not for the screen.
      if (state.guide?.id !== guide.id) return
      if (result.ok) {
        if (result.data.operationId !== id) return
        applySaved(result.data.guide, sent, sentVersion)
        state.status =
          state.editVersion === sentVersion
            ? 'Saved to ContextLayer.'
            : 'Saved. Changes made while saving are not saved yet.'
        return
      }
      if (result.error.code === 'OUTCOME_UNKNOWN') {
        pendingCheck = { guideId: guide.id, base, version: sentVersion, sent, inputs }
        await checkSave()
        return
      }
      if (result.error.code === 'CONFLICT') state.conflict = true
      state.status = 'Not saved. Your changes are still here.'
      fail(result.error)
      // A conflict or a refusal keeps the edits: make sure their copy is current.
      void writeLocalNow()
    },

    checkSave,

    /** Puts back the steps kept in the browser session, on the revision they started from. */
    restoreLocal() {
      const local = state.recovery
      const guide = state.guide
      if (!local || local.guideId !== guide?.id) return
      state.recovery = null
      state.steps = fromLocal(local)
      state.baseRevision = local.baseRevision
      state.savedVersion = state.editVersion
      state.editVersion += 1
      state.local = 'kept'
      // Saved elsewhere since: saving will be refused until the author decides.
      state.conflict = local.baseRevision !== guide.revision
      state.status = state.conflict
        ? 'Unsaved changes restored. The guide was changed elsewhere since; review before saving.'
        : 'Unsaved changes restored.'
    },

    async discardLocal() {
      const local = state.recovery
      state.recovery = null
      if (local) await clearLocalNow(local.guideId)
      state.status = 'Kept changes discarded.'
    },

    /** Replaces the unsaved edits with the server's version (the view asks first). */
    async loadLatest() {
      const guide = state.guide
      if (!guide) return
      await clearLocalNow(guide.id)
      await load((id, applicationId) => client.open(id, applicationId, guide.id))
      state.recovery = null
    },

    /** From `pagehide`: write a pending copy now, without waiting. */
    flushLocal() {
      if (localTimer !== undefined) void writeLocalNow()
    },

    async exit() {
      if (!panelId) return
      if (state.capture) await cancelCapture()
      await client.exit(panelId)
      // Chrome closes the panel; if it did not, say so.
      state.phase = 'ended'
      state.endedReason = 'exited'
    },

    /** From `pagehide`: the panel is closing. */
    detach() {
      if (panelId) client.detach(panelId)
    },
  }
}

export type EditMode = ReturnType<typeof createEditMode>
