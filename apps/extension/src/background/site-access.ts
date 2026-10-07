import {
  EXTENSION_PATHS,
  extensionApplicationListSchema,
  originMatchPattern,
  publishedGuideListSchema,
  type ExtensionApplication,
  type PublishedGuideSummary,
} from '@contextlayer/shared'

import { matchPage } from '../lib/url-pattern'
import type { ApplicationListData, SiteStatusData } from '../messaging/protocol'
import { ApiUnreachableError } from './api-client'
import { ConnectionEndedError, NotConnectedError, type Auth } from './auth'
import type { Lifecycle } from './lifecycle'
import { randomToken } from './pkce'
import type { ConnectionRecord, SiteIntent, Vault } from './vault'

/**
 * Per-application site access (ADR 0017). ContextLayer runs on a page only
 * when four independent facts hold, and each one is checked where it lives:
 *
 *   connected (vault) ∧ activated by the user for this workspace (vault)
 *   ∧ registered as an application of that workspace (API, cached)
 *   ∧ granted by Chrome (chrome.permissions).
 *
 * `reconcile` turns that into dynamic content-script registrations with
 * deterministic ids, injects into tabs that are already open and tells pages
 * that lost access to stop. It is idempotent and serialized; it runs on
 * install, browser start, permission changes, connection changes and site
 * changes, never on a timer.
 */

/** Registrations with this prefix are ours; anything else is left alone. */
export const SCRIPT_ID_PREFIX = 'cl-site-'
/** How long the cached application list is trusted when a page asks. */
const APPLICATIONS_TTL_MS = 10 * 60_000
/** How long a "Turn on" request waits for Chrome's grant before it lapses. */
export const ACTIVATION_TTL_MS = 3 * 60_000

/** The few Chrome calls site access needs, so the logic can be tested without Chrome. */
export interface SiteChrome {
  hasHostAccess(pattern: string): Promise<boolean>
  /** Resolves false when Chrome refuses (e.g. a permission required by the manifest). */
  removeHostAccess(pattern: string): Promise<boolean>
  /** The tab's URL when the extension may see it (host access or activeTab). */
  tabUrl(tabId: number): Promise<string | undefined>
  registeredScripts(): Promise<{ id: string }[]>
  registerScripts(scripts: { id: string; pattern: string }[]): Promise<void>
  unregisterScripts(ids: string[]): Promise<void>
  tabsMatching(pattern: string): Promise<number[]>
  inject(tabId: number): Promise<void>
  sendToTab(tabId: number, message: unknown, documentId: string): Promise<void>
}

export type SiteStatus = SiteStatusData

/** What a content script may learn about itself: nothing but whether to run. */
export interface HelloResult {
  active: boolean
}

export type PageSender = Pick<
  chrome.runtime.MessageSender,
  'url' | 'origin' | 'frameId' | 'documentId' | 'tab'
>

/** `http(s)` pages only; browser pages, file:// and the like are out of scope. */
export function siteOrigin(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined
  const parsed = new URL(url)
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined
}

/** A stable registration id per origin: the same origin always maps to the same id. */
export async function scriptId(origin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin))
  const hex = [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${SCRIPT_ID_PREFIX}${hex}`
}

export type SiteAccess = ReturnType<typeof createSiteAccess>

export function createSiteAccess(deps: {
  vault: Vault
  auth: Auth
  lifecycle: Lifecycle
  chrome: SiteChrome
  /** Match pattern of the ContextLayer API, to tell when its access is withheld. */
  apiPattern: string
  now: () => number
}) {
  const { vault, auth, lifecycle, chrome, apiPattern, now } = deps
  let queue: Promise<void> = Promise.resolve()

  async function fetchApplications(connection: ConnectionRecord) {
    const list = await auth.authorized(EXTENSION_PATHS.applications, extensionApplicationListSchema)
    const items = list?.items ?? []
    await vault.writeApplications({ grantId: connection.id, fetchedAt: now(), items })
    return items
  }

  /**
   * The connection's applications: fresh when `force` or stale, otherwise
   * cached. When the API cannot be reached the last list is used; `undefined`
   * means nothing is known.
   */
  async function applications(
    connection: ConnectionRecord,
    force: boolean,
  ): Promise<ExtensionApplication[] | undefined> {
    const cached = await vault.readApplications()
    const usable = cached?.grantId === connection.id ? cached : undefined
    if (!force && usable && now() - usable.fetchedAt < APPLICATIONS_TTL_MS) return usable.items
    try {
      return await fetchApplications(connection)
    } catch (error) {
      if (error instanceof ApiUnreachableError) return usable?.items
      throw error
    }
  }

  async function originOfTab(tabId: number) {
    return siteOrigin(await chrome.tabUrl(tabId))
  }

  /**
   * What a pending "Turn on" request deserves now. It never activates anything
   * but the exact origin the user asked for, in the connection they asked it in,
   * and only once Chrome granted that origin and it is still registered.
   */
  async function judgeIntent(intent: SiteIntent): Promise<'activate' | 'wait' | 'drop'> {
    if (intent.expiresAt <= now()) return 'drop'
    const connection = await vault.readConnection()
    if (connection?.id !== intent.grantId || connection.workspace.id !== intent.workspaceId) {
      return 'drop'
    }
    // The tab navigated elsewhere (or closed) while Chrome's prompt was open.
    if ((await originOfTab(intent.tabId)) !== intent.origin) return 'drop'
    if (!(await chrome.hasHostAccess(intent.pattern))) return 'wait'
    let apps: ExtensionApplication[] | undefined
    try {
      apps = await applications(connection, false)
    } catch {
      return 'drop'
    }
    if (apps === undefined) return 'wait'
    return apps.some((app) => app.origins.includes(intent.origin)) ? 'activate' : 'drop'
  }

  /** Completes or drops the pending request, at most once (idempotent). */
  async function settleIntent(): Promise<void> {
    const intent = await vault.readSiteIntent()
    if (!intent) return
    const verdict = await judgeIntent(intent)
    if (verdict === 'wait') return
    await lifecycle.exclusive(async () => {
      // Consumed, cancelled or replaced meanwhile: nothing to do.
      if ((await vault.readSiteIntent())?.id !== intent.id) return
      await vault.clearSiteIntent()
      if (verdict !== 'activate') return
      // Re-checked in the transition: Disconnect cannot slip in before the write.
      if ((await vault.readConnection())?.id !== intent.grantId) return
      const sites = await vault.readSites(intent.workspaceId)
      if (!sites.includes(intent.origin)) {
        await vault.writeSites(intent.workspaceId, [...sites, intent.origin])
      }
    })
  }

  async function runReconcile(injectAll: boolean): Promise<void> {
    await settleIntent()
    const connection = await vault.readConnection()
    const current = (await chrome.registeredScripts()).filter((script) =>
      script.id.startsWith(SCRIPT_ID_PREFIX),
    )
    const currentIds = new Set(current.map((script) => script.id))
    const desired = new Map<string, string>()

    if (connection) {
      let apps: ExtensionApplication[] | undefined
      try {
        apps = await applications(connection, false)
      } catch (error) {
        if (!(error instanceof ConnectionEndedError || error instanceof NotConnectedError)) {
          throw error
        }
        // The connection just ended; its credentials are gone and nothing may run.
        apps = []
      }
      const registered = apps && new Set(apps.flatMap((app) => app.origins))
      const stillConnected = (await vault.readConnection()) !== undefined
      for (const origin of stillConnected ? await vault.readSites(connection.workspace.id) : []) {
        const id = await scriptId(origin)
        // Without a known application list, keep what runs but add nothing.
        const isRegistered = registered ? registered.has(origin) : currentIds.has(id)
        if (isRegistered && (await chrome.hasHostAccess(originMatchPattern(origin)))) {
          desired.set(id, origin)
        }
      }
    }

    const stale = current.filter((script) => !desired.has(script.id)).map((script) => script.id)
    const added = [...desired].filter(([id]) => !currentIds.has(id))
    if (stale.length > 0) await chrome.unregisterScripts(stale)
    if (added.length > 0) {
      await chrome.registerScripts(
        added.map(([id, origin]) => ({ id, pattern: originMatchPattern(origin) })),
      )
    }

    // Already open tabs: the registration only applies to future navigations.
    // After install, update or browser start every enabled origin is
    // re-injected; the content script's guard makes a second copy a no-op.
    const injectInto = injectAll ? [...desired.values()] : added.map(([, origin]) => origin)
    for (const origin of injectInto) {
      for (const tabId of await chrome.tabsMatching(originMatchPattern(origin))) {
        await chrome.inject(tabId).catch(() => undefined)
      }
    }

    // Pages that lost access are told to stop (cooperative teardown).
    const enabled = new Set(desired.values())
    const pages = await vault.readPages()
    for (const [tabId, page] of Object.entries(pages)) {
      if (enabled.has(page.origin)) continue
      await chrome
        .sendToTab(Number(tabId), { type: 'page.deactivate' }, page.documentId)
        .catch(() => undefined)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by tab id.
      delete pages[tabId]
    }
    await vault.writePages(pages)
  }

  function reconcile(options: { injectAll?: boolean } = {}): Promise<void> {
    queue = queue.then(
      () => runReconcile(options.injectAll ?? false),
      () => runReconcile(options.injectAll ?? false),
    )
    return queue
  }

  async function status(tabId: number): Promise<SiteStatus> {
    const url = await chrome.tabUrl(tabId)
    const origin = siteOrigin(url)
    if (url === undefined || origin === undefined) return { state: 'unsupported' }
    const connection = await vault.readConnection()
    if (!connection) return { state: 'disconnected', origin }
    if (!(await chrome.hasHostAccess(apiPattern))) return { state: 'api-withheld', origin }

    let apps: ExtensionApplication[] | undefined
    try {
      apps = await applications(connection, true)
    } catch (error) {
      if (error instanceof ConnectionEndedError || error instanceof NotConnectedError) {
        await reconcile()
        return { state: 'disconnected', origin }
      }
      throw error
    }
    // The list may have changed (application deleted, origin edited).
    await reconcile()
    if (apps === undefined) return { state: 'api-unreachable', origin }

    const names = apps.filter((app) => app.origins.includes(origin)).map((app) => app.name)
    if (names.length === 0) {
      return { state: 'not-registered', origin, workspace: connection.workspace.name }
    }
    const pattern = originMatchPattern(origin)
    const activated = (await vault.readSites(connection.workspace.id)).includes(origin)
    const granted = await chrome.hasHostAccess(pattern)
    if (!activated) {
      return {
        state: 'available',
        origin,
        pattern,
        applications: names,
        permission: granted ? 'granted' : 'missing',
      }
    }
    if (!granted) return { state: 'permission-missing', origin, pattern, applications: names }

    let guides: PublishedGuideSummary[] | null = null
    let moreGuides = false
    try {
      const page = await auth.authorized(
        `${EXTENSION_PATHS.guides}?${new URLSearchParams({ origin }).toString()}`,
        publishedGuideListSchema,
      )
      // The API narrows by origin; the start page is matched here, where
      // URLPattern exists. No start page: any page of the origin.
      guides = (page?.items ?? []).filter(
        (guide) => matchPage(guide.startUrlPattern, url) === 'match',
      )
      moreGuides = (page?.nextCursor ?? null) !== null
    } catch (error) {
      if (!(error instanceof ApiUnreachableError)) throw error
    }
    return { state: 'active', origin, pattern, applications: names, guides, moreGuides }
  }

  return {
    reconcile,
    status,

    /** The connection's applications for the popup; an origin is "on" when all four facts hold. */
    async applications(): Promise<ApplicationListData> {
      const connection = await vault.readConnection()
      if (!connection) return { applications: null }
      let apps: ExtensionApplication[] | undefined
      try {
        apps = await applications(connection, true)
      } catch (error) {
        if (error instanceof ConnectionEndedError || error instanceof NotConnectedError) {
          return { applications: null }
        }
        throw error
      }
      if (apps === undefined) return { applications: null }
      const enabled = new Set(await vault.readSites(connection.workspace.id))
      const result = []
      for (const app of apps) {
        const origins = []
        for (const origin of app.origins) {
          const on = enabled.has(origin) && (await chrome.hasHostAccess(originMatchPattern(origin)))
          origins.push({ origin, on })
        }
        result.push({ id: app.id, name: app.name, origins })
      }
      return { applications: result }
    },

    /**
     * "Turn on" for the tab's site, sent by the popup from the user's click just
     * before it asks Chrome for the origin. Stored as a pending request bound to
     * the connection, the exact origin and the tab, so it completes when Chrome
     * grants the origin (here at once if it already did, or on
     * `permissions.onAdded` through `reconcile`) even if the popup is gone.
     * A grant without such a request activates nothing.
     */
    async requestActivation(tabId: number): Promise<{ intentId: string | null }> {
      const origin = await originOfTab(tabId)
      if (origin === undefined) return { intentId: null }
      const intent = await lifecycle.exclusive(async () => {
        const connection = await vault.readConnection()
        if (!connection) return undefined
        const createdAt = now()
        const request: SiteIntent = {
          id: randomToken(),
          grantId: connection.id,
          workspaceId: connection.workspace.id,
          origin,
          pattern: originMatchPattern(origin),
          tabId,
          createdAt,
          expiresAt: createdAt + ACTIVATION_TTL_MS,
        }
        // One request at a time: a newer one replaces any earlier one.
        await vault.writeSiteIntent(request)
        return request
      })
      if (!intent) return { intentId: null }
      await reconcile()
      return { intentId: intent.id }
    },

    /** Chrome refused, or the user gave up: the request is dropped. */
    cancelActivation: (intentId: string): Promise<{ cancelled: boolean }> =>
      lifecycle.exclusive(async () => {
        if ((await vault.readSiteIntent())?.id !== intentId) return { cancelled: false }
        await vault.clearSiteIntent()
        return { cancelled: true }
      }),

    /** Turns ContextLayer off for the tab's site and gives Chrome's access back. */
    async disable(tabId: number): Promise<SiteStatus> {
      const origin = await originOfTab(tabId)
      if (origin !== undefined) {
        const changed = await lifecycle.exclusive(async () => {
          const connection = await vault.readConnection()
          if (!connection) return false
          if ((await vault.readSiteIntent())?.origin === origin) await vault.clearSiteIntent()
          const sites = await vault.readSites(connection.workspace.id)
          await vault.writeSites(
            connection.workspace.id,
            sites.filter((site) => site !== origin),
          )
          return true
        })
        if (changed) {
          const pattern = originMatchPattern(origin)
          if (pattern !== apiPattern) await chrome.removeHostAccess(pattern)
          await reconcile()
        }
      }
      return status(tabId)
    },

    /**
     * The applications of the connection registered for an origin, from the
     * cached list (as `hello` uses it); `undefined` when nothing is known.
     */
    async applicationIdsFor(origin: string): Promise<string[] | undefined> {
      const connection = await vault.readConnection()
      if (!connection) return undefined
      let apps: ExtensionApplication[] | undefined
      try {
        apps = await applications(connection, false)
      } catch {
        return undefined
      }
      return apps?.filter((app) => app.origins.includes(origin)).map((app) => app.id)
    },

    /**
     * A content script asks whether it may run. Only Chrome's facts about the
     * sender count (top frame, document, origin), never the message.
     */
    async hello(sender: PageSender): Promise<HelloResult> {
      const tabId = sender.tab?.id
      const origin = siteOrigin(sender.url)
      if (
        tabId === undefined ||
        sender.frameId !== 0 ||
        sender.documentId === undefined ||
        origin === undefined ||
        sender.origin !== origin
      ) {
        return { active: false }
      }
      const connection = await vault.readConnection()
      if (!connection) return { active: false }
      if (!(await vault.readSites(connection.workspace.id)).includes(origin)) {
        return { active: false }
      }
      if (!(await chrome.hasHostAccess(originMatchPattern(origin)))) return { active: false }
      let apps: ExtensionApplication[] | undefined
      try {
        apps = await applications(connection, false)
      } catch {
        return { active: false }
      }
      if (!apps?.some((app) => app.origins.includes(origin))) return { active: false }

      const pages = await vault.readPages()
      pages[String(tabId)] = { origin, documentId: sender.documentId }
      await vault.writePages(pages)
      return { active: true }
    },

    async pageClosed(tabId: number): Promise<void> {
      const pages = await vault.readPages()
      if (!(String(tabId) in pages)) return
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by tab id.
      delete pages[String(tabId)]
      await vault.writePages(pages)
    },
  }
}
