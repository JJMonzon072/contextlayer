import { extensionApplicationSchema } from '@contextlayer/shared'
import { z } from 'zod'

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
  applications: 'cl.applications',
  pages: 'cl.pages',
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

/** The connection's registered applications, cached for this browser session. */
const applicationsCacheSchema = z.object({
  grantId: z.string(),
  fetchedAt: z.number(),
  items: z.array(extensionApplicationSchema),
})

/** Pages whose content script was authorized, by tab: told to stop when access ends. */
const pagesSchema = z.record(z.string(), z.object({ origin: z.string(), documentId: z.string() }))

/** Why the last connection ended without the user disconnecting. */
const endedSchema = z.object({ reason: z.enum(['ended']), at: z.number() })

export type Attempt = z.infer<typeof attemptSchema>
export type AccessRecord = z.infer<typeof accessSchema>
export type RefreshRecord = z.infer<typeof refreshSchema>
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>
export type ApplicationsCache = z.infer<typeof applicationsCacheSchema>
export type PageRecords = z.infer<typeof pagesSchema>

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

    readApplications: () => read(storage.session, KEYS.applications, applicationsCacheSchema),
    writeApplications: (cache: ApplicationsCache) =>
      storage.session.set({ [KEYS.applications]: cache }),

    readPages: async () => (await read(storage.session, KEYS.pages, pagesSchema)) ?? {},
    writePages: (pages: PageRecords) => storage.session.set({ [KEYS.pages]: pages }),

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
      await storage.session.remove([KEYS.refresh, KEYS.connection, KEYS.sites, KEYS.applications])
      if (ended) await storage.session.set({ [KEYS.ended]: { reason: 'ended', at } })
      else await storage.session.remove(KEYS.ended)
    },
  }
}
