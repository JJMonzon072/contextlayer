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
import { healthReportSchema } from '@contextlayer/shared'
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
  api: z.enum(['ok', 'unreachable']),
})

export type ConnectionStatusData = z.infer<typeof connectionStatusSchema>

export const connectionStatusResultSchema = messageResultSchema(connectionStatusSchema)

export const disconnectResultSchema = messageResultSchema(
  z.object({ serverConfirmed: z.boolean() }),
)

/**
 * Worker → extension pages: "the connection changed, ask again". Carries no
 * data, so a forged copy (content scripts can message extension pages) can at
 * most trigger a status refresh.
 */
export const CONNECTION_CHANGED = { type: 'connection.changed' } as const

// --- Requests handled by the content script ----------------------------------

export const contentRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page.ping') }),
])

export type ContentRequest = z.infer<typeof contentRequestSchema>

export const pageInfoSchema = z.object({
  url: z.string(),
  title: z.string(),
  extensionVersion: z.string(),
  /** API status as seen through the background service worker. */
  api: z.enum(['ok', 'unavailable', 'unreachable']),
})

export type PageInfo = z.infer<typeof pageInfoSchema>

export const pageInfoResultSchema = messageResultSchema(pageInfoSchema)
