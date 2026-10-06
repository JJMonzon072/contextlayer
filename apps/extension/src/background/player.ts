import { extensionGuidePath, originMatchPattern, publishedGuideSchema } from '@contextlayer/shared'

import { richTextLines } from '../lib/rich-text-lines'
import { matchPage } from '../lib/url-pattern'
import { failure, success, type MessageResult, type PlayerStep } from '../messaging/protocol'
import { ApiStatusError, ApiUnreachableError } from './api-client'
import { ConnectionEndedError, NotConnectedError, type Auth } from './auth'
import type { Lifecycle } from './lifecycle'
import { randomToken } from './pkce'
import { siteOrigin, type PageSender } from './site-access'
import type { PlayerRun, PlayerRuns, Vault } from './vault'

/**
 * The Guide Player in the service worker (Phase 6a). The worker fetches the
 * published guide, keeps the run and decides which step is shown; the page
 * only resolves and draws the step it is sent:
 *
 *   popup ──player.start──▶ worker ──GET guide──▶ API
 *   worker ──player.show{step}──▶ content script (resolves the target, draws)
 *   content script ──player.go / player.end{runId, generation}──▶ worker
 *
 * At most one run per tab, and tabs are independent: a run is bound to the
 * connection (grant and workspace), its tab, the tab's origin, the document
 * it showed when the guide started and one published version (its snapshot
 * is kept with the run). A page's request is checked against its own tab's
 * run, that binding and the run's generation; anything else is stale and
 * changes nothing, and no page can reach another tab's run. Runs live in
 * `storage.session` (`cl.players`, by tab): they survive the worker stopping
 * between events. A tab's run ends with Finish, Close, a new document in that
 * tab, that tab closing, Edit Mode opening on that tab, or a newer start on
 * that tab; the runs of a site end when it is turned off or its access is
 * withdrawn; every run ends with Disconnect. The player never clicks, types
 * or acts on the page.
 *
 * Fail-closed ordering: a run's `player.show` is sent from inside the
 * transition that stores it, and every `player.hide` from inside the
 * transition that ends or replaces it, so a tab receives a run's hide after
 * its show; the page also refuses a show for a run it was told to hide.
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

const without = (runs: PlayerRuns, ended: (run: PlayerRun) => boolean): PlayerRuns =>
  Object.fromEntries(Object.entries(runs).filter(([, run]) => !ended(run)))

export function createPlayer(deps: PlayerDeps) {
  const { vault, auth, lifecycle, chrome, now } = deps
  /**
   * The latest start asked for on each tab. A slower, older start never
   * replaces a newer one, nor a run that Edit Mode or a closed tab ended
   * meanwhile. In memory on purpose: a stopped worker loses its requests in
   * flight with it, like the life cycle's generations (ADR 0015).
   */
  const latestStart = new Map<number, string>()

  /** Tells a run's page to remove it. Sent, never awaited: a silent page holds nothing up. */
  function hide(run: PlayerRun): void {
    chrome
      .sendToTab(run.tabId, { type: 'player.hide', runId: run.id }, run.documentId)
      .catch(() => undefined)
  }

  /**
   * Ends the runs `ended` selects, in one transition (storage only). With
   * `hide`, each page is told from inside the transition, after the show its
   * own start sent. Returns the runs it ended.
   */
  function endRuns(ended: (run: PlayerRun) => boolean, options: { hide: boolean }) {
    return lifecycle.exclusive(async () => {
      const runs = await vault.readPlayers()
      const matching = Object.values(runs).filter(ended)
      if (matching.length === 0) return matching
      await vault.writePlayers(without(runs, ended))
      if (options.hide) for (const run of matching) hide(run)
      return matching
    })
  }

  async function start(
    tabId: number,
    guideId: string,
    version: number,
    startId: string,
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
    if (url === undefined || matchPage(published.snapshot.guide.startUrlPattern, url) !== 'match') {
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
    // Re-checked in one transition after the network: a newer start, Edit
    // Mode, a reload, a closed tab or Disconnect may have come in meanwhile.
    const installed = await lifecycle.exclusive(async () => {
      if (latestStart.get(tabId) !== startId) return 'superseded'
      if (lifecycle.credentialGeneration() !== generation) return 'stale'
      if ((await vault.readConnection())?.id !== connection.id) return 'stale'
      const current = (await vault.readPages())[String(tabId)]
      if (current?.documentId !== page.documentId || current.origin !== origin) return 'moved'
      if ((await vault.readAuthoring())?.tabId === tabId) return 'edit-mode'
      const runs = await vault.readPlayers()
      const previous = runs[String(tabId)]
      try {
        await vault.writePlayers({ ...runs, [String(tabId)]: run })
      } catch {
        return 'full'
      }
      // This tab's previous run only; other tabs keep theirs.
      if (previous) hide(previous)
      return {
        shown: chrome
          .sendToTab(tabId, { type: 'player.show', step: stepOf(run) }, run.documentId)
          .catch(() => undefined),
      }
    })
    if (installed === 'superseded') {
      return failure('STALE', 'Another guide was started on this tab meanwhile.')
    }
    if (installed === 'stale') return failure('STALE', 'The connection to ContextLayer changed.')
    if (installed === 'moved') {
      return failure('PAGE_CHANGED', 'The page changed. Open the popup again to play the guide.')
    }
    if (installed === 'edit-mode') {
      return failure('NOT_AVAILABLE', 'Edit Mode is open on this tab. Exit it to play a guide.')
    }
    if (installed === 'full') {
      return failure('NOT_AVAILABLE', 'Too many guides are playing. Close one and try again.')
    }

    const answer = await installed.shown
    // Ended or replaced while the page was answering: never reported as started.
    if ((await vault.readPlayers())[String(tabId)]?.id !== run.id) {
      return failure('STALE', 'This guide was ended or replaced before it appeared.')
    }
    if (!isShown(answer)) {
      await endRuns((current) => current.id === run.id, { hide: true })
      return failure('PAGE_CHANGED', 'The guide could not be shown on this page. Reload it.')
    }
    return success({ runId: run.id })
  }

  return {
    /**
     * Starts the published guide on the tab: the page must be one ContextLayer
     * runs on, the guide's application must be registered for it, the
     * version must be the one the popup listed and the guide's start page
     * must match. Edit Mode on the same tab refuses it: the two never overlap.
     * A run already playing on this tab is replaced; other tabs keep theirs.
     */
    async start(
      tabId: number,
      guideId: string,
      version: number,
    ): Promise<MessageResult<{ runId: string }>> {
      const startId = randomToken()
      latestStart.set(tabId, startId)
      try {
        return await start(tabId, guideId, version, startId)
      } finally {
        if (latestStart.get(tabId) === startId) latestStart.delete(tabId)
      }
    },

    /**
     * Previous or Next from a run's page. A request about an older step (`generation`) changes
     * nothing and gets the step now shown back, so the page catches up; a
     * request from anywhere but the run's own page is stale.
     */
    async go(
      sender: PageSender,
      runId: string,
      generation: number,
      direction: 'next' | 'previous',
    ): Promise<MessageResult<PlayerStep>> {
      const stale = failure('STALE', 'This guide is no longer playing.')
      const tabId = sender.tab?.id
      if (tabId === undefined) return stale
      const run = (await vault.readPlayers())[String(tabId)]
      if (run?.id !== runId || !fromRunPage(sender, run)) return stale

      return lifecycle.exclusive(async () => {
        const runs = await vault.readPlayers()
        const current = runs[String(tabId)]
        if (current?.id !== runId || !fromRunPage(sender, current)) return stale
        if ((await vault.readConnection())?.id !== current.grantId) {
          await vault.writePlayers(without(runs, (other) => other.id === current.id))
          return failure('STALE', 'The connection to ContextLayer changed.')
        }
        if (generation !== current.generation) return success(stepOf(current))
        const step = current.step + (direction === 'next' ? 1 : -1)
        if (step < 0 || step >= current.snapshot.steps.length) {
          return failure('BAD_REQUEST', 'There is no step there.')
        }
        const next = { ...current, step, generation: current.generation + 1 }
        await vault.writePlayers({ ...runs, [String(tabId)]: next })
        return success(stepOf(next))
      })
    },

    /** Finish or Close from a run's page: that run ends (the page already removed its UI). */
    async end(sender: PageSender, runId: string): Promise<MessageResult<{ done: boolean }>> {
      const ended = await endRuns((run) => run.id === runId && fromRunPage(sender, run), {
        hide: false,
      })
      return success({ done: ended.length > 0 })
    },

    /** A content script was authorized: a new document in a tab ends that tab's run. */
    async pageHello(sender: PageSender): Promise<void> {
      const tabId = sender.tab?.id
      if (tabId === undefined) return
      await endRuns((run) => run.tabId === tabId && run.documentId !== sender.documentId, {
        hide: false,
      })
    },

    /** The tab closed: its run ends, and a start still on its way for it does not land. */
    async tabClosed(tabId: number): Promise<void> {
      latestStart.delete(tabId)
      await endRuns((run) => run.tabId === tabId, { hide: false })
    },

    /** Edit Mode attached to the tab: the guide playing there ends first, and its UI goes. */
    async endOnTab(tabId: number): Promise<void> {
      latestStart.delete(tabId)
      await endRuns((run) => run.tabId === tabId, { hide: true })
    },

    /**
     * After a connection, permission or site change: the runs whose
     * connection was replaced, or whose site is no longer on, end.
     */
    async verify(): Promise<void> {
      const runs = Object.values(await vault.readPlayers())
      if (runs.length === 0) return
      const connection = await vault.readConnection()
      const off = new Set<string>()
      for (const run of runs) {
        if (
          connection?.id !== run.grantId ||
          connection.workspace.id !== run.workspaceId ||
          !(await vault.readSites(run.workspaceId)).includes(run.origin) ||
          !(await chrome.hasHostAccess(originMatchPattern(run.origin)))
        ) {
          off.add(run.id)
        }
      }
      if (off.size > 0) await endRuns((run) => off.has(run.id), { hide: true })
    },
  }
}
