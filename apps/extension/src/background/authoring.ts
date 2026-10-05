import {
  extensionAuthoringGuidePath,
  extensionAuthoringGuidesPath,
  extensionAuthoringStepsPath,
  guideListSchema,
  guideSchema,
  originMatchPattern,
  targetDescriptorSchema,
  type Guide,
  type GuideSummary,
  type ReplaceStepsRequest,
} from '@contextlayer/shared'

import {
  failure,
  PICKER_TTL_MS,
  success,
  type AuthoringAttachData,
  type AuthoringCaptureData,
  type AuthoringStateData,
  type FinalCopy,
  type LocalDraft,
  type LocalDraftInput,
  type MessageResult,
} from '../messaging/protocol'
import { ApiStatusError, ApiUnreachableError } from './api-client'
import { ConnectionEndedError, NotConnectedError, type Auth } from './auth'
import type { Lifecycle } from './lifecycle'
import { randomToken } from './pkce'
import { siteOrigin, type PageSender } from './site-access'
import type { AuthoringSession, Vault } from './vault'

/**
 * Edit Mode in the service worker (Phase 5). The worker is the only context
 * that calls the API and the only one that may start a capture:
 *
 *   side panel ──authoring.*──▶ worker ──picker.start{captureId}──▶ content script
 *   content script ──picker.result{captureId}──▶ worker ──authoring.changed──▶ panel
 *
 * One session at a time, bound to the connection (grant and workspace), the
 * panel that attached (`panelId`), one tab, its origin and the document it
 * showed, the open guide and, while capturing, one capture request. Every
 * request is checked against that binding; every late answer (API or page)
 * is checked again when it arrives and dropped as stale when the connection,
 * session, guide or request changed meanwhile. A captured descriptor is
 * validated with the shared schema and only offered to the panel for review:
 * nothing is saved until the author saves.
 *
 * The session lives in `storage.session`, so it survives the worker being
 * stopped between events; it never keeps the worker alive (no ports, no
 * timers).
 */

export interface AuthoringChrome {
  hasHostAccess(pattern: string): Promise<boolean>
  tabUrl(tabId: number): Promise<string | undefined>
  /** Resolves with the content script's answer; rejects when the document is gone. */
  sendToTab(tabId: number, message: unknown, documentId: string): Promise<unknown>
  /** Closes and disables the side panel for this tab. */
  closePanel(tabId: number): Promise<void>
}

export interface AuthoringDeps {
  vault: Vault
  auth: Auth
  lifecycle: Lifecycle
  chrome: AuthoringChrome
  /** The connection's applications registered for an origin (fresh from the API). */
  applicationsFor: (origin: string) => Promise<{ id: string; name: string }[] | undefined>
  now: () => number
  /** Tells extension pages that the session changed (`authoring.changed`). */
  notify: () => void
  /** Largest local copy, in characters (default `MAX_LOCAL_DRAFT_CHARS`). */
  maxLocalDraftChars?: number
}

/**
 * Largest local copy kept in `storage.session` (10 MB per extension): the
 * API's limit for one step replacement, so any draft that can be saved fits.
 */
export const MAX_LOCAL_DRAFT_CHARS = 2 * 1024 * 1024

type Reason = Extract<AuthoringStateData, { state: 'ended' }>['reason']

/** The answer to a copy: kept, or why not (`outdated`: a newer copy of this panel is kept). */
type CopyResult = MessageResult<{
  stored: boolean
  reason: 'too-large' | 'quota' | 'outdated' | null
}>

/** Endings the panel or its tab caused: the copy it sends while closing is still the author's. */
const OWN_ENDINGS: readonly Reason[] = ['closed', 'tab-closed', 'exited']

const isOk = (value: unknown) =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true

function apiFailure(error: unknown): MessageResult<never> {
  if (error instanceof ConnectionEndedError || error instanceof NotConnectedError) {
    return failure('STALE', 'The connection to ContextLayer ended.')
  }
  if (error instanceof ApiStatusError) {
    if (error.status === 403) {
      return failure('FORBIDDEN', 'Your role in this workspace cannot edit guides.')
    }
    if (error.status === 404) return failure('NOT_FOUND', error.message)
    if (error.status === 409) return failure('CONFLICT', error.message)
    if (error.status === 400) return failure('BAD_REQUEST', error.message)
  }
  if (error instanceof ApiUnreachableError) {
    return failure('API_UNREACHABLE', 'The ContextLayer API could not be reached.')
  }
  throw error
}

export type Authoring = ReturnType<typeof createAuthoring>

export function createAuthoring(deps: AuthoringDeps) {
  const { vault, auth, lifecycle, chrome, now, notify } = deps
  /** One save at a time per session (in memory: a stopped worker has no save in flight). */
  let saving: string | undefined

  /**
   * Ends the session in storage and records why, and what it was bound to,
   * for its panel. Storage only: call it inside a transition, then `cleanUp`.
   */
  async function endSession(session: AuthoringSession, reason: Reason): Promise<AuthoringSession> {
    await vault.clearAuthoring()
    await vault.writeAuthoringEnded({
      panelId: session.panelId,
      reason,
      grantId: session.grantId,
      workspaceId: session.workspaceId,
      guide: session.guide,
    })
    return session
  }

  /**
   * Removes any preview or picker an ended session left on its page. Sent at
   * once, never awaited inside a transition: a page that does not answer
   * holds up nothing, and the clean-up never waits for the network.
   */
  function cleanUp(session: AuthoringSession): void {
    chrome
      .sendToTab(session.tabId, { type: 'preview.hide' }, session.documentId)
      .catch(() => undefined)
    if (session.capture?.state === 'pending') {
      chrome
        .sendToTab(
          session.tabId,
          { type: 'picker.stop', captureId: session.capture.id },
          session.documentId,
        )
        .catch(() => undefined)
    }
  }

  /** Ends `session` if it is still the stored one, then cleans its page up. */
  async function end(session: AuthoringSession, reason: Reason): Promise<boolean> {
    const ended = await lifecycle.exclusive(async () => {
      const current = await vault.readAuthoring()
      return current?.id === session.id ? endSession(current, reason) : undefined
    })
    if (ended) cleanUp(ended)
    return ended !== undefined
  }

  /** The session if this panel owns it and the connection is still the one it started with. */
  async function owned(panelId: string): Promise<AuthoringSession | MessageResult<never>> {
    const session = await vault.readAuthoring()
    if (session?.panelId !== panelId) {
      return failure('STALE', 'This side panel no longer owns the Edit Mode session.')
    }
    const connection = await vault.readConnection()
    if (connection?.id !== session.grantId || connection.workspace.id !== session.workspaceId) {
      return failure('STALE', 'The connection to ContextLayer changed.')
    }
    return session
  }

  const isFailure = (
    value: AuthoringSession | MessageResult<never>,
  ): value is MessageResult<never> => 'ok' in value

  /** Applies `change` only if the session is still `session.id` (and returns the stored result). */
  function update(
    session: AuthoringSession,
    change: (current: AuthoringSession) => AuthoringSession | undefined,
  ): Promise<AuthoringSession | undefined> {
    return lifecycle.exclusive(async () => {
      const current = await vault.readAuthoring()
      if (current?.id !== session.id) return undefined
      const next = change(current)
      if (next) await vault.writeAuthoring(next)
      return next
    })
  }

  /** The page record must still be the document the session is bound to. */
  async function pageReady(session: AuthoringSession): Promise<boolean> {
    const page = (await vault.readPages())[String(session.tabId)]
    return page?.documentId === session.documentId && page.origin === session.origin
  }

  async function pause(session: AuthoringSession, reason: 'navigated' | 'page-gone') {
    await update(session, (current) => ({
      ...current,
      paused: reason,
      capture:
        current.capture?.state === 'pending'
          ? { ...current.capture, state: 'cancelled', reason: 'The page changed.' }
          : current.capture,
    }))
    notify()
  }

  /** Guards a late API answer: same connection, same session and same guide load. */
  async function stillCurrent(
    session: AuthoringSession,
    generation: number,
    check: (current: AuthoringSession) => boolean = () => true,
  ): Promise<boolean> {
    if (lifecycle.credentialGeneration() !== generation) return false
    const current = await vault.readAuthoring()
    return current?.id === session.id && current.panelId === session.panelId && check(current)
  }

  async function readLocal(session: AuthoringSession, guideId: string): Promise<LocalDraft | null> {
    const draft = await vault.readDraft()
    if (
      draft?.grantId !== session.grantId ||
      draft.workspaceId !== session.workspaceId ||
      draft.guideId !== guideId
    ) {
      return null
    }
    const {
      grantId: _grant,
      workspaceId: _workspace,
      panelId: _panel,
      version: _version,
      ...local
    } = draft
    return local
  }

  /**
   * Keeps a panel's copy of its unsaved steps, bound to the connection, the
   * guide, the panel and its edit version. Inside a transition, after the
   * caller checked that `owner` may write. A copy never replaces a newer one
   * from the same panel; a copy too large to keep is refused, never cut.
   */
  async function storeCopy(
    owner: Pick<AuthoringSession, 'grantId' | 'workspaceId' | 'guide'>,
    panelId: string,
    draft: LocalDraftInput,
    version: number,
  ): Promise<CopyResult> {
    if (
      owner.guide?.guideId !== draft.guideId ||
      owner.guide.applicationId !== draft.applicationId
    ) {
      return failure('STALE', 'This guide is no longer open in Edit Mode.')
    }
    const current = await vault.readDraft()
    if (current?.panelId === panelId && current.version >= version) {
      return success(
        current.version === version
          ? { stored: true, reason: null }
          : { stored: false, reason: 'outdated' },
      )
    }
    const stored = {
      ...draft,
      grantId: owner.grantId,
      workspaceId: owner.workspaceId,
      panelId,
      version,
      savedAt: now(),
    }
    if (JSON.stringify(stored).length > (deps.maxLocalDraftChars ?? MAX_LOCAL_DRAFT_CHARS)) {
      return success({ stored: false, reason: 'too-large' })
    }
    try {
      await vault.writeDraft(stored)
    } catch {
      return success({ stored: false, reason: 'quota' })
    }
    return success({ stored: true, reason: null })
  }

  /**
   * The copy a panel sends with its own close, when its session was already
   * ended by that same close (Chrome's panel-closed event, the tab closing,
   * Exit): still kept, but only for the connection and guide that session
   * had, and only if no newer session started since. Inside a transition.
   */
  async function storeClosingCopy(panelId: string, final: FinalCopy): Promise<void> {
    if (await vault.readAuthoring()) return
    const ended = await vault.readAuthoringEnded()
    if (
      ended?.panelId !== panelId ||
      !OWN_ENDINGS.includes(ended.reason) ||
      ended.grantId === undefined ||
      ended.workspaceId === undefined
    ) {
      return
    }
    const connection = await vault.readConnection()
    if (connection?.id !== ended.grantId || connection.workspace.id !== ended.workspaceId) return
    await storeCopy(
      { grantId: ended.grantId, workspaceId: ended.workspaceId, guide: ended.guide ?? null },
      panelId,
      final.draft,
      final.version,
    )
  }

  /**
   * The panel closes (or leaves): its last copy, if it sent one, is kept and
   * the session ends, in one transition, so nothing the panel sent before is
   * judged against an already ended session. Then the page is cleaned up.
   */
  async function closeSession(
    panelId: string,
    reason: 'closed' | 'exited',
    final: FinalCopy | undefined,
  ): Promise<AuthoringSession | undefined> {
    const ended = await lifecycle.exclusive(async () => {
      const session = await vault.readAuthoring()
      if (session?.panelId !== panelId) {
        if (final) await storeClosingCopy(panelId, final)
        return undefined
      }
      const owner = await owned(panelId)
      if (final && !isFailure(owner)) {
        await storeCopy(owner, panelId, final.draft, final.version)
      }
      return endSession(session, reason)
    })
    if (ended) {
      cleanUp(ended)
      notify()
    }
    return ended
  }

  async function loadGuide(
    session: AuthoringSession,
    applicationId: string,
    load: () => Promise<Guide | undefined>,
  ): Promise<MessageResult<{ guide: Guide; local: LocalDraft | null }>> {
    if (!session.applicationIds.includes(applicationId)) {
      return failure('NOT_FOUND', 'This application is not registered for this page.')
    }
    const loadId = randomToken()
    const generation = lifecycle.credentialGeneration()
    await update(session, (current) => ({ ...current, loadId }))
    let guide: Guide | undefined
    try {
      guide = await load()
    } catch (error) {
      return apiFailure(error)
    }
    if (!guide) return failure('NOT_FOUND', 'Guide not found.')
    const loaded = guide
    // A newer load (another guide picked meanwhile), Disconnect or another
    // panel make this answer stale, even a 200.
    if (!(await stillCurrent(session, generation, (current) => current.loadId === loadId))) {
      return failure('STALE', 'Another guide was opened meanwhile.')
    }
    const opened = await update(session, (current) =>
      current.loadId === loadId
        ? {
            ...current,
            guide: { applicationId, guideId: loaded.id },
            // A capture belongs to the guide it was started for.
            capture:
              current.capture?.state === 'pending' && current.capture.guideId !== loaded.id
                ? { ...current.capture, state: 'cancelled', reason: 'Another guide was opened.' }
                : current.capture,
          }
        : undefined,
    )
    if (!opened) return failure('STALE', 'Another guide was opened meanwhile.')
    if (session.capture?.state === 'pending' && session.capture.guideId !== loaded.id) {
      await chrome
        .sendToTab(
          session.tabId,
          { type: 'picker.stop', captureId: session.capture.id },
          session.documentId,
        )
        .catch(() => undefined)
    }
    return success({ guide: loaded, local: await readLocal(session, loaded.id) })
  }

  /** A content script's message about a capture: only the bound page, document and request count. */
  async function settleCapture(
    sender: PageSender,
    captureId: string,
    settle: (session: AuthoringSession) => {
      state: AuthoringCaptureData['state']
      descriptor: AuthoringCaptureData['descriptor']
      reason: string | null
    },
  ): Promise<{ accepted: boolean }> {
    const accepted = await lifecycle.exclusive(async () => {
      const session = await vault.readAuthoring()
      const origin = siteOrigin(sender.url)
      if (
        !session ||
        sender.tab?.id !== session.tabId ||
        sender.frameId !== 0 ||
        sender.documentId !== session.documentId ||
        origin !== session.origin ||
        sender.origin !== session.origin
      ) {
        return false
      }
      const capture = session.capture
      // Unsolicited, repeated, cancelled or for an older request.
      if (capture?.id !== captureId || capture.state !== 'pending') return false
      if (capture.expiresAt <= now()) {
        await vault.writeAuthoring({
          ...session,
          capture: { ...capture, state: 'expired', reason: 'The selection timed out.' },
        })
        return false
      }
      await vault.writeAuthoring({ ...session, capture: { ...capture, ...settle(session) } })
      return true
    })
    if (accepted) notify()
    return { accepted }
  }

  async function state(panelId: string): Promise<AuthoringStateData> {
    const session = await vault.readAuthoring()
    if (session?.panelId === panelId) {
      const connection = await vault.readConnection()
      if (connection?.id !== session.grantId) {
        await end(session, 'connection-changed')
        return { state: 'ended', reason: 'connection-changed' }
      }
      const capture = session.capture
      if (capture?.state === 'pending' && capture.expiresAt <= now()) {
        await update(session, (current) =>
          current.capture?.id === capture.id
            ? {
                ...current,
                capture: { ...capture, state: 'expired', reason: 'The selection timed out.' },
              }
            : undefined,
        )
        return state(panelId)
      }
      return {
        state: 'active',
        paused: session.paused,
        guide: session.guide,
        capture: capture && { id: capture.id, state: capture.state, reason: capture.reason },
      }
    }
    const ended = await vault.readAuthoringEnded()
    if (ended?.panelId === panelId) return { state: 'ended', reason: ended.reason }
    if (!(await vault.readConnection())) return { state: 'ended', reason: 'disconnected' }
    return { state: 'ended', reason: session ? 'moved' : 'closed' }
  }

  /**
   * The panel is closing (its pagehide, with its last unconfirmed copy, or
   * Chrome's panel-closed event): nothing may stay on the page.
   */
  async function detach(
    panelId: string,
    final?: FinalCopy,
  ): Promise<MessageResult<{ done: boolean }>> {
    return success({ done: (await closeSession(panelId, 'closed', final)) !== undefined })
  }

  return {
    /**
     * A side panel opened for a tab. The page must be one ContextLayer runs on
     * (the content script said hello for its current document), registered as
     * at least one application of the connection's workspace. A new panel
     * takes the session over; the previous one is told it moved.
     */
    async attach(tabId: number): Promise<MessageResult<AuthoringAttachData>> {
      const connection = await vault.readConnection()
      if (!connection) return failure('NOT_AVAILABLE', 'Connect ContextLayer first.')
      const origin = siteOrigin(await chrome.tabUrl(tabId))
      const page = (await vault.readPages())[String(tabId)]
      if (
        origin === undefined ||
        page?.origin !== origin ||
        !(await vault.readSites(connection.workspace.id)).includes(origin) ||
        !(await chrome.hasHostAccess(originMatchPattern(origin)))
      ) {
        return failure(
          'NOT_AVAILABLE',
          'ContextLayer is not active on this page. Turn it on from the popup, or reload the page.',
        )
      }
      let applications: { id: string; name: string }[] | undefined
      try {
        applications = await deps.applicationsFor(origin)
      } catch (error) {
        return apiFailure(error)
      }
      if (!applications?.length) {
        return failure('NOT_AVAILABLE', 'This page is not a registered application.')
      }
      const session: AuthoringSession = {
        id: randomToken(),
        panelId: randomToken(),
        grantId: connection.id,
        workspaceId: connection.workspace.id,
        tabId,
        origin,
        documentId: page.documentId,
        applicationIds: applications.map((application) => application.id),
        paused: null,
        guide: null,
        loadId: null,
        capture: null,
        createdAt: now(),
      }
      const installed = await lifecycle.exclusive(async () => {
        // Disconnected or replaced while the applications were loading.
        if ((await vault.readConnection())?.id !== connection.id) return undefined
        const previous = await vault.readAuthoring()
        if (previous) await endSession(previous, 'moved')
        await vault.writeAuthoring(session)
        return { previous }
      })
      if (!installed) return failure('STALE', 'The connection to ContextLayer changed.')
      if (installed.previous) cleanUp(installed.previous)
      notify()
      return success({
        panelId: session.panelId,
        workspace: connection.workspace,
        user: { displayName: connection.user.displayName },
        origin,
        applications,
      })
    },

    state,

    async guides(
      panelId: string,
      applicationId: string,
    ): Promise<MessageResult<{ items: GuideSummary[] }>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      if (!session.applicationIds.includes(applicationId)) {
        return failure('NOT_FOUND', 'This application is not registered for this page.')
      }
      const generation = lifecycle.credentialGeneration()
      try {
        const page = await auth.authorized(
          `${extensionAuthoringGuidesPath(applicationId)}?limit=100`,
          guideListSchema,
        )
        if (!(await stillCurrent(session, generation))) {
          return failure('STALE', 'The Edit Mode session changed.')
        }
        return success({ items: page?.items ?? [] })
      } catch (error) {
        return apiFailure(error)
      }
    },

    async open(panelId: string, applicationId: string, guideId: string) {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      return loadGuide(session, applicationId, () =>
        auth.authorized(extensionAuthoringGuidePath(applicationId, guideId), guideSchema),
      )
    },

    async create(panelId: string, applicationId: string, title: string) {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      return loadGuide(session, applicationId, () =>
        auth.authorized(extensionAuthoringGuidesPath(applicationId), guideSchema, {
          method: 'POST',
          body: { title },
        }),
      )
    },

    /** "Continue on this page" after a reload or navigation within the same origin. */
    async resume(panelId: string): Promise<MessageResult<{ done: boolean }>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      const page = (await vault.readPages())[String(session.tabId)]
      const origin = siteOrigin(await chrome.tabUrl(session.tabId))
      if (page?.origin !== session.origin || origin !== session.origin) {
        return failure(
          'NOT_AVAILABLE',
          `ContextLayer is not active on this page. Go back to ${session.origin} or reload it.`,
        )
      }
      await update(session, (current) => ({
        ...current,
        documentId: page.documentId,
        paused: null,
      }))
      notify()
      return success({ done: true })
    },

    /** Asks the bound page for one element, under a new capture request. */
    async startCapture(panelId: string): Promise<MessageResult<{ captureId: string }>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      if (!session.guide) return failure('BAD_REQUEST', 'Open a guide first.')
      if (session.paused) return failure('PAGE_CHANGED', 'The page changed. Continue first.')
      if (!(await pageReady(session))) {
        await pause(session, 'navigated')
        return failure('PAGE_CHANGED', 'The page was reloaded or changed.')
      }
      const guideId = session.guide.guideId
      const captureId = randomToken()
      const previous = session.capture
      const started = await update(session, (current) =>
        current.guide?.guideId === guideId && current.paused === null
          ? {
              ...current,
              capture: {
                id: captureId,
                guideId,
                expiresAt: now() + PICKER_TTL_MS,
                state: 'pending',
                descriptor: null,
                reason: null,
              },
            }
          : undefined,
      )
      if (!started) return failure('STALE', 'The Edit Mode session changed.')
      if (previous?.state === 'pending') {
        await chrome
          .sendToTab(
            session.tabId,
            { type: 'picker.stop', captureId: previous.id },
            session.documentId,
          )
          .catch(() => undefined)
      }
      const answer = await chrome
        .sendToTab(
          session.tabId,
          { type: 'picker.start', captureId, ttlMs: PICKER_TTL_MS },
          session.documentId,
        )
        .catch(() => undefined)
      if (!isOk(answer)) {
        await update(session, (current) =>
          current.capture?.id === captureId
            ? {
                ...current,
                capture: {
                  ...current.capture,
                  state: 'failed',
                  reason: 'The page did not answer.',
                },
              }
            : undefined,
        )
        await pause(session, 'page-gone')
        return failure('PAGE_CHANGED', 'The page could not be reached. Reload it, then continue.')
      }
      notify()
      return success({ captureId })
    },

    async cancelCapture(panelId: string): Promise<MessageResult<{ done: boolean }>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      const capture = session.capture
      if (capture?.state !== 'pending') return success({ done: false })
      await update(session, (current) =>
        current.capture?.id === capture.id && current.capture.state === 'pending'
          ? { ...current, capture: { ...capture, state: 'cancelled', reason: 'Cancelled.' } }
          : undefined,
      )
      await chrome
        .sendToTab(
          session.tabId,
          { type: 'picker.stop', captureId: capture.id },
          session.documentId,
        )
        .catch(() => undefined)
      notify()
      return success({ done: true })
    },

    /**
     * Previews a step on the bound page, on the element selected there under
     * `captureId`. The page answers `shown: false` when it no longer holds that
     * element (reloaded, removed): the author selects it again. No lookup.
     */
    async showPreview(
      panelId: string,
      captureId: string,
      title: string,
      lines: string[],
    ): Promise<MessageResult<{ shown: boolean }>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      if (session.paused) return failure('PAGE_CHANGED', 'The page changed. Continue first.')
      if (!(await pageReady(session))) {
        await pause(session, 'navigated')
        return failure('PAGE_CHANGED', 'The page was reloaded or changed.')
      }
      const answer = await chrome
        .sendToTab(
          session.tabId,
          { type: 'preview.show', captureId, title, lines },
          session.documentId,
        )
        .catch(() => undefined)
      if (!isOk(answer)) {
        await pause(session, 'page-gone')
        return failure('PAGE_CHANGED', 'The page could not be reached. Reload it, then continue.')
      }
      const shown = (answer as { data?: { shown?: unknown } }).data?.shown === true
      return success({ shown })
    },

    async hidePreview(panelId: string): Promise<MessageResult<{ done: boolean }>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      await chrome
        .sendToTab(session.tabId, { type: 'preview.hide' }, session.documentId)
        .catch(() => undefined)
      return success({ done: true })
    },

    /** The capture's outcome for its panel; a descriptor only for the current guide's request. */
    async takeCapture(
      panelId: string,
      captureId: string,
    ): Promise<MessageResult<AuthoringCaptureData>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      const capture = session.capture
      if (capture?.id !== captureId || capture.guideId !== session.guide?.guideId) {
        return failure('STALE', 'This capture request is no longer current.')
      }
      return success({
        id: capture.id,
        state: capture.state,
        descriptor: capture.descriptor,
        reason: capture.reason,
      })
    },

    pickerResult(
      sender: PageSender,
      captureId: string,
      outcome: { ok: true; descriptor: unknown } | { ok: false; reason: string },
    ): Promise<{ accepted: boolean }> {
      return settleCapture(sender, captureId, (session) => {
        if (!outcome.ok) return { state: 'failed', descriptor: null, reason: outcome.reason }
        // Untrusted input from the page: the full shared schema, plus the page it claims.
        const parsed = targetDescriptorSchema.safeParse(outcome.descriptor)
        const hostname = new URL(session.origin).hostname
        if (!parsed.success || parsed.data.page.urlPattern.hostname !== hostname) {
          return {
            state: 'failed',
            descriptor: null,
            reason: 'The selected element could not be validated. Try another one.',
          }
        }
        return { state: 'done', descriptor: parsed.data, reason: null }
      })
    },

    pickerCancelled(
      sender: PageSender,
      captureId: string,
      reason: 'escape' | 'timeout',
    ): Promise<{ accepted: boolean }> {
      return settleCapture(sender, captureId, () => ({
        state: reason === 'timeout' ? 'expired' : 'cancelled',
        descriptor: null,
        reason: reason === 'timeout' ? 'The selection timed out.' : 'Cancelled on the page.',
      }))
    },

    /**
     * Saves the panel's steps with the revision they were based on. One save
     * at a time; the answer is returned only if the connection, the session
     * and the open guide are still the ones it was sent for. A lost answer is
     * `OUTCOME_UNKNOWN`: the panel reloads the guide before deciding anything.
     */
    async save(
      panelId: string,
      operationId: string,
      applicationId: string,
      guideId: string,
      request: ReplaceStepsRequest,
    ): Promise<MessageResult<{ operationId: string; guide: Guide }>> {
      const session = await owned(panelId)
      if (isFailure(session)) return session
      if (session.guide?.guideId !== guideId || session.guide.applicationId !== applicationId) {
        return failure('STALE', 'This guide is no longer open in Edit Mode.')
      }
      if (saving !== undefined) return failure('BAD_REQUEST', 'A save is already in progress.')
      saving = operationId
      const generation = lifecycle.credentialGeneration()
      try {
        const guide = await auth.authorized(
          extensionAuthoringStepsPath(applicationId, guideId),
          guideSchema,
          { method: 'PUT', body: request },
        )
        if (!guide) {
          return failure('OUTCOME_UNKNOWN', 'The save was sent, but its answer was lost.')
        }
        if (
          !(await stillCurrent(
            session,
            generation,
            (current) => current.guide?.guideId === guideId,
          ))
        ) {
          return failure('STALE', 'The Edit Mode session changed while saving.')
        }
        return success({ operationId, guide })
      } catch (error) {
        if (error instanceof ApiStatusError && error.status < 500) return apiFailure(error)
        if (error instanceof ConnectionEndedError || error instanceof NotConnectedError) {
          return apiFailure(error)
        }
        // Network failure, timeout, a 5xx or an unreadable answer: the save may
        // or may not have been applied.
        return failure('OUTCOME_UNKNOWN', 'The save was sent, but its answer was lost.')
      } finally {
        if (saving === operationId) saving = undefined
      }
    },

    /**
     * Keeps the unsaved steps in `storage.session`, bound to this connection,
     * guide, panel and edit version. The ownership check and the write are one
     * transition, so Disconnect or a newer session always wins.
     */
    writeLocal(panelId: string, draft: LocalDraftInput, version: number): Promise<CopyResult> {
      return lifecycle.exclusive(async () => {
        const session = await owned(panelId)
        if (isFailure(session)) return session
        return storeCopy(session, panelId, draft, version)
      })
    },

    /**
     * Drops the guide's copy, unless this panel wrote a newer one than
     * `version` since. One transition with the ownership check, so an old
     * request never deletes the copy of a later session.
     */
    clearLocal(
      panelId: string,
      guideId: string,
      version: number,
    ): Promise<MessageResult<{ done: boolean }>> {
      return lifecycle.exclusive(async () => {
        const session = await owned(panelId)
        if (isFailure(session)) return session
        const draft = await vault.readDraft()
        if (
          draft?.guideId !== guideId ||
          draft.grantId !== session.grantId ||
          draft.workspaceId !== session.workspaceId ||
          (draft.panelId === panelId && draft.version > version)
        ) {
          return success({ done: false })
        }
        await vault.clearDraft()
        return success({ done: true })
      })
    },

    /** "Exit Edit Mode": keeps the panel's last copy, ends the session and closes the panel. */
    async exit(panelId: string, final?: FinalCopy): Promise<MessageResult<{ done: boolean }>> {
      const ended = await closeSession(panelId, 'exited', final)
      if (!ended) return success({ done: false })
      await chrome.closePanel(ended.tabId).catch(() => undefined)
      return success({ done: true })
    },

    detach,

    async panelClosed(tabId: number): Promise<void> {
      const session = await vault.readAuthoring()
      if (session?.tabId === tabId) await detach(session.panelId)
    },

    /** A content script was authorized: a new document in the session's tab pauses the session. */
    async pageHello(sender: PageSender): Promise<void> {
      const session = await vault.readAuthoring()
      if (!session || sender.tab?.id !== session.tabId) return
      if (sender.documentId === session.documentId || session.paused !== null) return
      await pause(session, 'navigated')
    },

    async tabClosed(tabId: number): Promise<void> {
      const session = await vault.readAuthoring()
      if (session?.tabId !== tabId) return
      if (await end(session, 'tab-closed')) notify()
    },

    /**
     * After a connection, permission or site change: a session whose
     * connection was replaced, or whose site is no longer on, ends.
     */
    async verify(): Promise<void> {
      const session = await vault.readAuthoring()
      if (!session) return
      const connection = await vault.readConnection()
      let reason: Reason | undefined
      if (connection?.id !== session.grantId)
        reason = connection ? 'connection-changed' : 'disconnected'
      else if (
        !(await vault.readSites(session.workspaceId)).includes(session.origin) ||
        !(await chrome.hasHostAccess(originMatchPattern(session.origin)))
      ) {
        reason = 'site-off'
      }
      if (!reason) return
      await end(session, reason)
      // An unsaved copy from another connection is never offered again.
      await lifecycle.exclusive(async () => {
        const draft = await vault.readDraft()
        if (draft && draft.grantId !== (await vault.readConnection())?.id) await vault.clearDraft()
      })
      notify()
    },
  }
}
