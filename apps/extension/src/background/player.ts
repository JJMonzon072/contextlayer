import {
  EXTENSION_PATHS,
  extensionGuidePath,
  originMatchPattern,
  publishedGuideSchema,
} from '@contextlayer/shared'

import { FOCUS_GUIDE_COMMAND } from '../commands'
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
 * between events. A tab's run ends with Finish, Close, that tab closing, Edit
 * Mode opening on that tab, a newer start on that tab, or a page of another
 * application in that tab; the runs of a site end when it is turned off or its access is
 * withdrawn; every run ends with Disconnect, and with a revocation, found at
 * the latest on the next Previous or Next (`GET /v1/extension/session`, the
 * bearer check the popup's status already makes). The player never clicks,
 * types or acts on the page.
 *
 * New documents (Phase 6b, ADR 0019): a link, a form or a reload loads a new
 * document, and bfcache brings one back. Each document `page.hello`
 * authorized asks for its tab's run with `player.resume`; the run is bound to
 * it (document, origin, next generation) and its current step returned,
 * never step 1, after the same connection check as Previous / Next. The
 * document it was bound to before is stale from then on.
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
  /** The ids of the applications registered for an origin, from the cached list. */
  applicationsOn: (origin: string) => Promise<string[] | undefined>
  now: () => number
  /** How long a page's answer to `player.show` is awaited (default `ANSWER_TIMEOUT_MS`). */
  answerTimeoutMs?: number
}

/**
 * A message to a document in the back/forward cache is never answered (ADR
 * 0019), so a page's answer is awaited this long at most.
 */
export const ANSWER_TIMEOUT_MS = 5_000

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

  /**
   * Whether the API still accepts the connection. Only a refused one is
   * `ended` (the auth module then cleared it, as for any request); an
   * unreachable or failing API is `unknown`, never taken for a revocation
   * (Phase 4 policy), and playback goes on with the guide already loaded.
   */
  async function checkConnection(): Promise<'valid' | 'ended' | 'unknown'> {
    try {
      await auth.authorized(EXTENSION_PATHS.session, undefined)
      return 'valid'
    } catch (error) {
      // Revoked, expired, reused, or replaced or disconnected meanwhile.
      if (error instanceof ConnectionEndedError || error instanceof NotConnectedError) {
        return 'ended'
      }
      if (error instanceof ApiUnreachableError || error instanceof ApiStatusError) return 'unknown'
      throw error
    }
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

    const answer = await Promise.race([
      installed.shown,
      new Promise<undefined>((resolve) => {
        setTimeout(() => {
          resolve(undefined)
        }, deps.answerTimeoutMs ?? ANSWER_TIMEOUT_MS)
      }),
    ])
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
     * Previous or Next from a run's page. The API is asked first whether the
     * connection still stands, so a revoked one ends every run it had instead
     * of playing on. A request about an older step (`generation`) changes
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
      const before = await vault.readPlayers()
      const run = before[String(tabId)]
      if (run?.id !== runId || !fromRunPage(sender, run)) return stale

      if ((await checkConnection()) === 'ended') {
        const ofGrant = (current: PlayerRun) => current.grantId === run.grantId
        // Usually already cleared with the connection; every page is told.
        const ended = await endRuns(ofGrant, { hide: false })
        const told = new Set<string>()
        for (const current of [...Object.values(before).filter(ofGrant), ...ended]) {
          if (told.has(current.id)) continue
          told.add(current.id)
          hide(current)
        }
        return failure('STALE', 'The connection to ContextLayer ended.')
      }

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

    /**
     * A document `page.hello` authorized asks for its tab's run: a link, a
     * form, a reload or bfcache brought it. The run is bound to this document
     * (and origin) with the next generation, and its current step returned.
     * Nothing to resume is `null`. A revoked connection ends the runs it had
     * (the same check as Previous / Next); a page of another application ends
     * this tab's run; ContextLayer never turns a site on or asks for access
     * here (`page.hello` only authorizes sites already on and granted).
     */
    async resume(sender: PageSender): Promise<MessageResult<PlayerStep | null>> {
      const tabId = sender.tab?.id
      const origin = siteOrigin(sender.url)
      if (
        tabId === undefined ||
        sender.frameId !== 0 ||
        sender.documentId === undefined ||
        origin === undefined ||
        sender.origin !== origin
      ) {
        return success(null)
      }
      const before = await vault.readPlayers()
      const run = before[String(tabId)]
      if (!run) return success(null)
      // Only the document `page.hello` authorized for this tab.
      const page = (await vault.readPages())[String(tabId)]
      if (page?.documentId !== sender.documentId || page.origin !== origin) return success(null)

      if ((await checkConnection()) === 'ended') {
        const ofGrant = (current: PlayerRun) => current.grantId === run.grantId
        const ended = await endRuns(ofGrant, { hide: false })
        const told = new Set<string>()
        for (const current of [...Object.values(before).filter(ofGrant), ...ended]) {
          if (told.has(current.id) || current.documentId === sender.documentId) continue
          told.add(current.id)
          hide(current)
        }
        return failure('STALE', 'The connection to ContextLayer ended.')
      }
      const applications = await deps.applicationsOn(origin)

      return lifecycle.exclusive(async () => {
        const runs = await vault.readPlayers()
        const current = runs[String(tabId)]
        if (current?.id !== run.id) return success(null)
        const drop = async () => {
          await vault.writePlayers(without(runs, (other) => other.id === current.id))
          return success(null)
        }
        const connection = await vault.readConnection()
        if (connection?.id !== current.grantId || connection.workspace.id !== current.workspaceId) {
          return drop()
        }
        if ((await vault.readPages())[String(tabId)]?.documentId !== sender.documentId) {
          return success(null)
        }
        if ((await vault.readAuthoring())?.tabId === tabId) return drop()
        // A page of another application: this guide does not belong here.
        if (applications !== undefined && !applications.includes(current.applicationId)) {
          return drop()
        }
        if (applications === undefined) return success(null)
        if (current.documentId === sender.documentId && current.origin === origin) {
          return success(stepOf(current))
        }
        const next = {
          ...current,
          documentId: sender.documentId ?? current.documentId,
          origin,
          generation: current.generation + 1,
        }
        await vault.writePlayers({ ...runs, [String(tabId)]: next })
        return success(stepOf(next))
      })
    },

    /**
     * A keyboard command (`chrome.commands`) on a tab: `focus-guide` asks the
     * page that shows the tab's guide to move the focus to its card. Nothing
     * happens on a tab without a guide. Returns whether a page was asked.
     */
    async command(name: string, tabId: number): Promise<boolean> {
      if (name !== FOCUS_GUIDE_COMMAND) return false
      const run = (await vault.readPlayers())[String(tabId)]
      if (!run) return false
      chrome.sendToTab(tabId, { type: 'player.focus' }, run.documentId).catch(() => undefined)
      return true
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
