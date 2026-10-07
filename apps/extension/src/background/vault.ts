import {
  extensionApplicationSchema,
  guideSnapshotSchema,
  targetDescriptorSchema,
} from '@contextlayer/shared'
import { z } from 'zod'

import { AUTHORING_END_REASONS, CAPTURE_STATES, localDraftSchema } from '../messaging/protocol'
import type { ExtensionStorage, StorageArea } from './storage'

/**
 * Typed access to what the worker keeps in chrome.storage. Every value is
 * validated on read: storage written by an older build or tampered with is
 * treated as absent. Nothing here is ever sent to a content script.
 */
const KEYS = {
  attempt: 'cl.attempt',
  access: 'cl.access',
  refresh: 'cl.refresh',
  connection: 'cl.connection',
  ended: 'cl.ended',
  sites: 'cl.sites',
  siteIntent: 'cl.siteIntent',
  applications: 'cl.applications',
  pages: 'cl.pages',
  authoring: 'cl.authoring',
  authoringEnded: 'cl.authoringEnded',
  authoringDraft: 'cl.authoringDraft',
  players: 'cl.players',
} as const

export const attemptSchema = z.object({
  id: z.string(),
  state: z.string(),
  verifier: z.string(),
  challenge: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  /** The dashboard tab this attempt opened; null until the tab exists. */
  tabId: z.number().int().nullable(),
})

const accessSchema = z.object({ grantId: z.string(), token: z.string(), expiresAt: z.number() })
const refreshSchema = z.object({ grantId: z.string(), token: z.string() })

export const connectionRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  user: z.object({ displayName: z.string(), email: z.string() }),
  workspace: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.string(),
  expiresAt: z.string(),
})

/** Origins the user turned ContextLayer on for, in one workspace. */
const sitesSchema = z.object({ workspaceId: z.string(), origins: z.array(z.string()) })

/**
 * The user asked to turn ContextLayer on for one origin and Chrome's prompt may
 * still be open: the worker completes the activation once Chrome grants the
 * origin, even if the popup that asked is gone (ADR 0017).
 */
export const siteIntentSchema = z.object({
  id: z.string(),
  /** The connection and workspace the request belongs to. */
  grantId: z.string(),
  workspaceId: z.string(),
  /** The exact origin and the pattern Chrome was asked for. */
  origin: z.string(),
  pattern: z.string(),
  /** The tab the popup was opened on: it must still show that origin. */
  tabId: z.number().int(),
  createdAt: z.number(),
  expiresAt: z.number(),
})

/** The connection's registered applications, cached for this browser session. */
const applicationsCacheSchema = z.object({
  grantId: z.string(),
  fetchedAt: z.number(),
  items: z.array(extensionApplicationSchema),
})

/** Pages whose content script was authorized, by tab: told to stop when access ends. */
const pagesSchema = z.record(z.string(), z.object({ origin: z.string(), documentId: z.string() }))

/**
 * The Edit Mode session (Phase 5): one side panel, bound to the connection,
 * one tab and the document it showed when the panel attached. Kept in
 * `storage.session` so it survives the worker stopping between events.
 */
export const authoringSessionSchema = z.object({
  id: z.string(),
  panelId: z.string(),
  grantId: z.string(),
  workspaceId: z.string(),
  tabId: z.number().int(),
  origin: z.string(),
  documentId: z.string(),
  /** Applications registered for `origin` when the panel attached. */
  applicationIds: z.array(z.string()),
  /** Set when the page was reloaded or left; cleared by an explicit "continue". */
  paused: z.enum(['navigated', 'page-gone']).nullable(),
  guide: z.object({ applicationId: z.string(), guideId: z.string() }).nullable(),
  /** The latest guide load: an older load that answers late is ignored. */
  loadId: z.string().nullable(),
  capture: z
    .object({
      id: z.string(),
      guideId: z.string(),
      expiresAt: z.number(),
      state: z.enum(CAPTURE_STATES),
      descriptor: targetDescriptorSchema.nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.number(),
})

/** Why the last session ended, for the panel that owned it. */
const authoringEndedSchema = z.object({
  panelId: z.string(),
  reason: z.enum(AUTHORING_END_REASONS),
  /** What the session was bound to, for the copy its panel sends while closing. */
  grantId: z.string().optional(),
  workspaceId: z.string().optional(),
  guide: z.object({ applicationId: z.string(), guideId: z.string() }).nullable().optional(),
})

/**
 * Unsaved steps, bound to the connection and workspace they were written in,
 * and to the panel and edit version that wrote them.
 */
const storedDraftSchema = localDraftSchema.extend({
  grantId: z.string(),
  workspaceId: z.string(),
  panelId: z.string(),
  version: z.number().int().nonnegative(),
})

/**
 * A guide being played (Phase 6a): bound to the connection, one tab, its
 * origin and document, and one published version, whose snapshot is kept so
 * a newer publication never changes a run. In `storage.session` only (never
 * in the API's database), so the current step survives the worker stopping
 * between events.
 */
export const playerRunSchema = z.object({
  id: z.string(),
  grantId: z.string(),
  workspaceId: z.string(),
  tabId: z.number().int(),
  origin: z.string(),
  documentId: z.string(),
  guideId: z.string(),
  applicationId: z.string(),
  version: z.number().int().min(1),
  snapshot: guideSnapshotSchema,
  /** Index of the step shown, in step order. */
  step: z.number().int().nonnegative(),
  /** Increases with every step change; the page echoes it back. */
  generation: z.number().int().nonnegative(),
  startedAt: z.number(),
})

/** Why the last connection ended without the user disconnecting. */
const endedSchema = z.object({ reason: z.enum(['ended']), at: z.number() })

export type Attempt = z.infer<typeof attemptSchema>
export type AccessRecord = z.infer<typeof accessSchema>
export type RefreshRecord = z.infer<typeof refreshSchema>
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>
export type ApplicationsCache = z.infer<typeof applicationsCacheSchema>
export type PageRecords = z.infer<typeof pagesSchema>
export type SiteIntent = z.infer<typeof siteIntentSchema>
export type AuthoringSession = z.infer<typeof authoringSessionSchema>
export type AuthoringEnded = z.infer<typeof authoringEndedSchema>
export type StoredDraft = z.infer<typeof storedDraftSchema>
export type PlayerRun = z.infer<typeof playerRunSchema>
/** The runs being played, at most one per tab, keyed by the tab id as a string. */
export type PlayerRuns = Record<string, PlayerRun>

/**
 * Reads the stored runs one by one: a malformed run, or one filed under
 * another tab's key, is dropped on its own without touching the other tabs'.
 */
function playerRunsOf(value: unknown): PlayerRuns {
  const record = z.record(z.string(), z.unknown()).safeParse(value)
  if (!record.success) return {}
  const runs: PlayerRuns = {}
  for (const [key, entry] of Object.entries(record.data)) {
    const run = playerRunSchema.safeParse(entry)
    if (run.success && String(run.data.tabId) === key) runs[key] = run.data
  }
  return runs
}

async function read<T>(
  area: StorageArea,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const value = (await area.get(key))[key]
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export type Vault = ReturnType<typeof createVault>

export function createVault(storage: ExtensionStorage) {
  let restricted: Promise<boolean> | undefined
  /** Called at worker start (top level) and awaited before any credential write. */
  const ready = () => (restricted ??= storage.restrictLocal())
  /** Where the refresh token and connection facts live. */
  const persistentArea = async () => ((await ready()) ? storage.local : storage.session)

  return {
    ready,
    /** False when local storage could not be restricted: credentials are session-only. */
    persistent: ready,

    readAttempt: () => read(storage.session, KEYS.attempt, attemptSchema),
    writeAttempt: (attempt: Attempt) => storage.session.set({ [KEYS.attempt]: attempt }),
    clearAttempt: () => storage.session.remove(KEYS.attempt),

    readAccess: () => read(storage.session, KEYS.access, accessSchema),
    writeAccess: (access: AccessRecord) => storage.session.set({ [KEYS.access]: access }),

    async readRefresh(): Promise<RefreshRecord | undefined> {
      return read(await persistentArea(), KEYS.refresh, refreshSchema)
    },
    async readConnection(): Promise<ConnectionRecord | undefined> {
      return read(await persistentArea(), KEYS.connection, connectionRecordSchema)
    },
    readEnded: () => read(storage.session, KEYS.ended, endedSchema),

    /** Activated origins of a workspace; another workspace's list counts as empty. */
    async readSites(workspaceId: string): Promise<string[]> {
      const sites = await read(await persistentArea(), KEYS.sites, sitesSchema)
      return sites?.workspaceId === workspaceId ? sites.origins : []
    },
    async writeSites(workspaceId: string, origins: string[]): Promise<void> {
      await (await persistentArea()).set({ [KEYS.sites]: { workspaceId, origins } })
    },

    readSiteIntent: () => read(storage.session, KEYS.siteIntent, siteIntentSchema),
    writeSiteIntent: (intent: SiteIntent) => storage.session.set({ [KEYS.siteIntent]: intent }),
    clearSiteIntent: () => storage.session.remove(KEYS.siteIntent),

    readApplications: () => read(storage.session, KEYS.applications, applicationsCacheSchema),
    writeApplications: (cache: ApplicationsCache) =>
      storage.session.set({ [KEYS.applications]: cache }),

    readPages: async () => (await read(storage.session, KEYS.pages, pagesSchema)) ?? {},
    writePages: (pages: PageRecords) => storage.session.set({ [KEYS.pages]: pages }),

    readAuthoring: () => read(storage.session, KEYS.authoring, authoringSessionSchema),
    writeAuthoring: (session: AuthoringSession) =>
      storage.session.set({ [KEYS.authoring]: session }),
    clearAuthoring: () => storage.session.remove(KEYS.authoring),
    readAuthoringEnded: () => read(storage.session, KEYS.authoringEnded, authoringEndedSchema),
    writeAuthoringEnded: (ended: AuthoringEnded) =>
      storage.session.set({ [KEYS.authoringEnded]: ended }),

    readDraft: () => read(storage.session, KEYS.authoringDraft, storedDraftSchema),
    writeDraft: (draft: StoredDraft) => storage.session.set({ [KEYS.authoringDraft]: draft }),
    clearDraft: () => storage.session.remove(KEYS.authoringDraft),

    /** The Guide Player's runs by tab (Phase 6a): each tab's run is independent. */
    readPlayers: async (): Promise<PlayerRuns> =>
      playerRunsOf((await storage.session.get(KEYS.players))[KEYS.players]),
    writePlayers: (runs: PlayerRuns) =>
      Object.keys(runs).length === 0
        ? storage.session.remove(KEYS.players)
        : storage.session.set({ [KEYS.players]: runs }),

    /** Stores a full credential set; the refresh token only in the protected area. */
    async saveConnection(values: {
      access: AccessRecord
      refresh: RefreshRecord
      connection: ConnectionRecord
    }): Promise<void> {
      const area = await persistentArea()
      await storage.session.set({ [KEYS.access]: values.access })
      await area.set({ [KEYS.refresh]: values.refresh, [KEYS.connection]: values.connection })
      await storage.session.remove(KEYS.ended)
    },

    /** Forgets every credential, in both areas. `ended` marks a connection lost on its own. */
    async clearConnection(ended: boolean, at: number): Promise<void> {
      await storage.session.remove(KEYS.access)
      await storage.local.remove([KEYS.refresh, KEYS.connection, KEYS.sites])
      await storage.session.remove([
        KEYS.refresh,
        KEYS.connection,
        KEYS.sites,
        KEYS.siteIntent,
        KEYS.applications,
        // Edit Mode belongs to the connection: no session or unsaved copy outlives it.
        KEYS.authoring,
        KEYS.authoringDraft,
        // So do the guides being played, in every tab.
        KEYS.players,
      ])
      if (ended) await storage.session.set({ [KEYS.ended]: { reason: 'ended', at } })
      else await storage.session.remove(KEYS.ended)
    },
  }
}
