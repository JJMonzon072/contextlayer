/**
 * Message protocol between the extension contexts.
 *
 *   popup ──runtime.sendMessage──▶ background (service worker) ──fetch──▶ API
 *   content script ──runtime.sendMessage──▶ background
 *   popup / background ──tabs.sendMessage──▶ content script
 *
 * Every message crossing a context boundary is validated with zod on the
 * receiving side. Content scripts run inside untrusted pages, so the background
 * treats their messages as untrusted input.
 */
import { healthReportSchema, publishedGuideSummarySchema } from '@contextlayer/shared'
import { z } from 'zod'

export const MESSAGE_ERROR_CODES = [
  'BAD_REQUEST',
  'FORBIDDEN',
  'API_UNREACHABLE',
  'NOT_AVAILABLE',
  'INTERNAL_ERROR',
] as const

export const messageErrorSchema = z.object({
  code: z.enum(MESSAGE_ERROR_CODES),
  message: z.string(),
})

/**
 * Responses are explicit results instead of thrown errors: exceptions do not
 * cross `chrome.runtime` message boundaries in a useful way.
 */
export function messageResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: messageErrorSchema }),
  ])
}

export type MessageError = z.infer<typeof messageErrorSchema>
export type MessageResult<T> = { ok: true; data: T } | { ok: false; error: MessageError }

export function success<T>(data: T): MessageResult<T> {
  return { ok: true, data }
}

export function failure(code: MessageError['code'], message: string): MessageResult<never> {
  return { ok: false, error: { code, message } }
}

// --- Requests handled by the background service worker ----------------------

export const backgroundRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('api.health.get') }),
  // Privileged: extension pages only (see ALLOWED_SENDERS in the worker).
  z.strictObject({ type: z.literal('connection.status') }),
  z.strictObject({ type: z.literal('connection.start') }),
  z.strictObject({ type: z.literal('connection.cancel') }),
  z.strictObject({ type: z.literal('connection.disconnect') }),
  z.strictObject({ type: z.literal('applications.list') }),
  z.strictObject({ type: z.literal('site.status'), tabId: z.number().int().nonnegative() }),
  // "Turn on": sent from the click, before Chrome's prompt; the worker completes it.
  z.strictObject({
    type: z.literal('site.requestActivation'),
    tabId: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('site.cancelActivation'), intentId: z.string().min(1) }),
  z.strictObject({ type: z.literal('site.disable'), tabId: z.number().int().nonnegative() }),
  // The only request a content script may send: "may I run on this page?"
  z.strictObject({ type: z.literal('page.hello') }),
])

export type BackgroundRequest = z.infer<typeof backgroundRequestSchema>

export const apiHealthResultSchema = messageResultSchema(healthReportSchema)

/** Public facts only: never a token, a verifier or a code. */
export const connectionStatusSchema = z.object({
  state: z.enum(['disconnected', 'connecting', 'connected', 'ended']),
  connection: z
    .object({
      id: z.string(),
      label: z.string(),
      user: z.object({ displayName: z.string(), email: z.string() }),
      workspace: z.object({ id: z.string(), name: z.string() }),
      createdAt: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
  attemptPending: z.boolean(),
  persistent: z.boolean(),
  /** `withheld`: the user turned off the extension's access to the API origin in Chrome. */
  api: z.enum(['ok', 'unreachable', 'withheld']),
})

export type ConnectionStatusData = z.infer<typeof connectionStatusSchema>

export const connectionStatusResultSchema = messageResultSchema(connectionStatusSchema)

export const disconnectResultSchema = messageResultSchema(
  z.object({ serverConfirmed: z.boolean() }),
)

const siteFields = {
  origin: z.string(),
  pattern: z.string(),
  /** Names of the workspace's applications registered for this origin. */
  applications: z.array(z.string()),
}

/** What the popup shows for the active tab's site (ADR 0017). */
export const siteStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unsupported') }),
  z.object({ state: z.literal('disconnected'), origin: z.string() }),
  z.object({ state: z.literal('api-withheld'), origin: z.string() }),
  z.object({ state: z.literal('api-unreachable'), origin: z.string() }),
  z.object({ state: z.literal('not-registered'), origin: z.string(), workspace: z.string() }),
  z.object({
    state: z.literal('available'),
    ...siteFields,
    permission: z.enum(['granted', 'missing']),
  }),
  z.object({ state: z.literal('permission-missing'), ...siteFields }),
  z.object({
    state: z.literal('active'),
    ...siteFields,
    /** `null` when the API could not be reached. */
    guides: z.array(publishedGuideSummarySchema).nullable(),
    moreGuides: z.boolean(),
  }),
])

export type SiteStatusData = z.infer<typeof siteStatusSchema>

export const siteStatusResultSchema = messageResultSchema(siteStatusSchema)

export const helloResultSchema = messageResultSchema(z.object({ active: z.boolean() }))

/** `intentId` is null when nothing could be requested (no connection, no http(s) page). */
export const activationRequestResultSchema = messageResultSchema(
  z.object({ intentId: z.string().nullable() }),
)

export const activationCancelResultSchema = messageResultSchema(
  z.object({ cancelled: z.boolean() }),
)

/** The connection's applications, each origin marked on when ContextLayer runs there. */
export const applicationListSchema = z.object({
  /** `null` when not connected, or when the API cannot be reached and nothing is cached. */
  applications: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        origins: z.array(z.object({ origin: z.string(), on: z.boolean() })),
      }),
    )
    .nullable(),
})

export type ApplicationListData = z.infer<typeof applicationListSchema>

export const applicationListResultSchema = messageResultSchema(applicationListSchema)

/**
 * Worker → extension pages: "the connection changed, ask again". Carries no
 * data, so a forged copy (content scripts can message extension pages) can at
 * most trigger a status refresh.
 */
export const CONNECTION_CHANGED = { type: 'connection.changed' } as const

// --- Requests handled by the content script ----------------------------------

export const contentRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('page.ping') }),
  // Sent by the worker when the site lost access: the script stops for good.
  z.strictObject({ type: z.literal('page.deactivate') }),
])

export type ContentRequest = z.infer<typeof contentRequestSchema>

export const pageInfoSchema = z.object({
  url: z.string(),
  title: z.string(),
  extensionVersion: z.string(),
})

export type PageInfo = z.infer<typeof pageInfoSchema>

export const pageInfoResultSchema = messageResultSchema(pageInfoSchema)
