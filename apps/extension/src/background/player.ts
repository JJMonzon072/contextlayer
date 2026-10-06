import { extensionGuidePath, originMatchPattern, publishedGuideSchema } from '@contextlayer/shared'

import { richTextLines } from '../lib/rich-text-lines'
import { matchPage } from '../lib/url-pattern'
import { failure, success, type MessageResult, type PlayerStep } from '../messaging/protocol'
import { ApiStatusError, ApiUnreachableError } from './api-client'
import { ConnectionEndedError, NotConnectedError, type Auth } from './auth'
import type { Lifecycle } from './lifecycle'
import { randomToken } from './pkce'
import { siteOrigin, type PageSender } from './site-access'
import type { PlayerRun, Vault } from './vault'

/**
 * The Guide Player in the service worker (Phase 6a). The worker fetches the
 * published guide, keeps the run and decides which step is shown; the page
 * only resolves and draws the step it is sent:
 *
 *   popup ──player.start──▶ worker ──GET guide──▶ API
 *   worker ──player.show{step}──▶ content script (resolves the target, draws)
 *   content script ──player.go / player.end{runId, generation}──▶ worker
 *
 * One run at a time, bound to the connection (grant and workspace), one tab,
 * its origin, the document it showed when the guide started and one
 * published version (its snapshot is kept with the run). A page's request is
 * checked against that binding and the run's generation; anything else is
 * stale and changes nothing. The run lives in `storage.session`: it survives
 * the worker stopping between events, and ends with Finish, Close, a new
 * document in its tab, the tab closing, Edit Mode opening on that tab, the
 * site being turned off, Disconnect and revocation. The player never clicks,
 * types or acts on the page.
 */

export interface PlayerChrome {
  hasHostAccess(pattern: string): Promise<boolean>
  tabUrl(tabId: number): Promise<string | undefined>
  /** Resolves with the content script's answer; rejects when the document is gone. */
  sendToTab(tabId: number, message: unknown, documentId: string): Promise<unknown>
}

export interface PlayerDeps {
  vault: Vault
  auth: Auth
  lifecycle: Lifecycle
  chrome: PlayerChrome
  /** The connection's applications registered (and on) for an origin. */
  applicationsFor: (origin: string) => Promise<{ id: string }[] | undefined>
  now: () => number
}

const STEP_LINE_MAX = 2_000

function apiFailure(error: unknown): MessageResult<never> {
  if (error instanceof ConnectionEndedError || error instanceof NotConnectedError) {
    return failure('STALE', 'The connection to ContextLayer ended.')
  }
  if (error instanceof ApiStatusError && error.status === 404) {
    return failure('NOT_FOUND', 'This guide is no longer published.')
  }
  if (error instanceof ApiUnreachableError) {
    return failure('API_UNREACHABLE', 'The ContextLayer API could not be reached.')
  }
  throw error
}

/** The step the run is on, as the page receives it. */
export function stepOf(run: PlayerRun): PlayerStep {
  const steps = [...run.snapshot.steps].sort((a, b) => a.position - b.position)
  const step = steps[run.step]
  if (!step) throw new Error('The run is outside its guide.')
  return {
    runId: run.id,
    generation: run.generation,
    guideTitle: run.snapshot.guide.title.slice(0, 120),
    index: run.step,
    count: steps.length,
    title: step.title.trim().slice(0, 120) || 'Untitled step',
    lines: richTextLines(step.body).map((line) => line.slice(0, STEP_LINE_MAX)),
    target: step.target,
    urlPattern: step.urlPattern,
    placement: step.placement,
  }
}

/** The top frame of the run's tab, document and origin, as Chrome reports the sender. */
function fromRunPage(sender: PageSender, run: PlayerRun): boolean {
  const origin = siteOrigin(sender.url)
  return (
    sender.tab?.id === run.tabId &&
    sender.frameId === 0 &&
    sender.documentId === run.documentId &&
    origin === run.origin &&
    sender.origin === run.origin
  )
}

const isShown = (answer: unknown) =>
  typeof answer === 'object' &&
  answer !== null &&
  (answer as { ok?: unknown }).ok === true &&
  (answer as { data?: { shown?: unknown } }).data?.shown === true

export type Player = ReturnType<typeof createPlayer>

export function createPlayer(deps: PlayerDeps) {
  const { vault, auth, lifecycle, chrome, now } = deps

  /** Removes a run's UI from its page. Sent, never awaited: a silent page holds nothing up. */
  function hide(run: PlayerRun): void {
    chrome
      .sendToTab(run.tabId, { type: 'player.hide', runId: run.id }, run.documentId)
      .catch(() => undefined)
  }

  /** Ends the stored run if `matches` it, in one transition (storage only); the ended run. */
  async function endWhere(matches: (run: PlayerRun) => boolean) {
    return lifecycle.exclusive(async () => {
      const run = await vault.readPlayer()
      if (!run || !matches(run)) return undefined
      await vault.clearPlayer()
      return run
    })
  }

  /** Ends the stored run if it matches, and removes its UI from its page. */
  async function endAndHide(matches: (run: PlayerRun) => boolean) {
    const ended = await endWhere(matches)
    if (ended) hide(ended)
    return ended !== undefined
  }

  return {
    /**
     * Starts the published guide on the tab: the page must be one ContextLayer
     * runs on, the guide's application must be registered for it, the
     * version must be the one the popup listed and the guide's start page
     * must match. Edit Mode on the same tab refuses it: the two never overlap.
     * A run already playing (here or in another tab) is replaced.
     */
    async start(
      tabId: number,
      guideId: string,
      version: number,
    ): Promise<MessageResult<{ runId: string }>> {
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
          'ContextLayer is not active on this page. Reload the page and try again.',
        )
      }
      if ((await vault.readAuthoring())?.tabId === tabId) {
        return failure('NOT_AVAILABLE', 'Edit Mode is open on this tab. Exit it to play a guide.')
      }

      const generation = lifecycle.credentialGeneration()
      let published
      let applications
      try {
        published = await auth.authorized(extensionGuidePath(guideId), publishedGuideSchema)
        applications = await deps.applicationsFor(origin)
      } catch (error) {
        return apiFailure(error)
      }
      if (!published) return failure('NOT_FOUND', 'This guide is no longer published.')
      if (published.version !== version) {
        return failure('STALE', 'This guide was published again. Open the popup again to play it.')
      }
      if (!applications?.some((application) => application.id === published.applicationId)) {
        return failure('NOT_FOUND', 'This guide is not for this site.')
      }
      const url = await chrome.tabUrl(tabId)
      if (
        url === undefined ||
        matchPage(published.snapshot.guide.startUrlPattern, url) !== 'match'
      ) {
        return failure('NOT_AVAILABLE', 'This guide starts on another page of this site.')
      }

      const run: PlayerRun = {
        id: randomToken(),
        grantId: connection.id,
        workspaceId: connection.workspace.id,
        tabId,
        origin,
        documentId: page.documentId,
        guideId: published.guideId,
        applicationId: published.applicationId,
        version: published.version,
        snapshot: published.snapshot,
        step: 0,
        generation: 0,
        startedAt: now(),
      }
      // Re-checked in one transition after the network: Disconnect, a reload
      // or Edit Mode may have come in meanwhile.
      const installed = await lifecycle.exclusive(async () => {
        if (lifecycle.credentialGeneration() !== generation) return 'stale'
        if ((await vault.readConnection())?.id !== connection.id) return 'stale'
        const current = (await vault.readPages())[String(tabId)]
        if (current?.documentId !== page.documentId || current.origin !== origin) return 'moved'
        if ((await vault.readAuthoring())?.tabId === tabId) return 'edit-mode'
        const previous = await vault.readPlayer()
        await vault.writePlayer(run)
        return { previous }
      })
      if (installed === 'stale') return failure('STALE', 'The connection to ContextLayer changed.')
      if (installed === 'moved') {
        return failure('PAGE_CHANGED', 'The page changed. Open the popup again to play the guide.')
      }
      if (installed === 'edit-mode') {
        return failure('NOT_AVAILABLE', 'Edit Mode is open on this tab. Exit it to play a guide.')
      }
      if (installed.previous) hide(installed.previous)

      const answer = await chrome
        .sendToTab(tabId, { type: 'player.show', step: stepOf(run) }, run.documentId)
        .catch(() => undefined)
      if (!isShown(answer)) {
        await endWhere((current) => current.id === run.id)
        return failure('PAGE_CHANGED', 'The guide could not be shown on this page. Reload it.')
      }
      return success({ runId: run.id })
    },

    /**
     * Previous or Next from the run's page. A request about an older step
     * (`generation`) changes nothing and gets the step now shown back, so the
     * page catches up; a request from anywhere else is stale.
     */
    go(
      sender: PageSender,
      runId: string,
      generation: number,
      direction: 'next' | 'previous',
    ): Promise<MessageResult<PlayerStep>> {
      return lifecycle.exclusive(async () => {
        const run = await vault.readPlayer()
        if (run?.id !== runId || !fromRunPage(sender, run)) {
          return failure('STALE', 'This guide is no longer playing.')
        }
        if ((await vault.readConnection())?.id !== run.grantId) {
          await vault.clearPlayer()
          return failure('STALE', 'The connection to ContextLayer changed.')
        }
        if (generation !== run.generation) return success(stepOf(run))
        const step = run.step + (direction === 'next' ? 1 : -1)
        if (step < 0 || step >= run.snapshot.steps.length) {
          return failure('BAD_REQUEST', 'There is no step there.')
        }
        const next = { ...run, step, generation: run.generation + 1 }
        await vault.writePlayer(next)
        return success(stepOf(next))
      })
    },

    /** Finish or Close from the run's page: the run ends (the page already removed its UI). */
    async end(sender: PageSender, runId: string): Promise<MessageResult<{ done: boolean }>> {
      const ended = await endWhere((run) => run.id === runId && fromRunPage(sender, run))
      return success({ done: ended !== undefined })
    },

    /** A content script was authorized: a new document in the run's tab ends the run. */
    async pageHello(sender: PageSender): Promise<void> {
      const tabId = sender.tab?.id
      if (tabId === undefined) return
      await endWhere((run) => run.tabId === tabId && run.documentId !== sender.documentId)
    },

    async tabClosed(tabId: number): Promise<void> {
      await endWhere((run) => run.tabId === tabId)
    },

    /** Edit Mode attached to the tab: the guide playing there ends first. */
    async endOnTab(tabId: number): Promise<void> {
      await endAndHide((run) => run.tabId === tabId)
    },

    /**
     * After a connection, permission or site change: a run whose connection
     * was replaced, or whose site is no longer on, ends.
     */
    async verify(): Promise<void> {
      const run = await vault.readPlayer()
      if (!run) return
      const connection = await vault.readConnection()
      const off =
        connection?.id !== run.grantId ||
        connection.workspace.id !== run.workspaceId ||
        !(await vault.readSites(run.workspaceId)).includes(run.origin) ||
        !(await chrome.hasHostAccess(originMatchPattern(run.origin)))
      if (off) await endAndHide((current) => current.id === run.id)
    },
  }
}
