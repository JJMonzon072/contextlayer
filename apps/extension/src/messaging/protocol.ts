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
  z.object({ type: z.literal('api.health.get') }),
])

export type BackgroundRequest = z.infer<typeof backgroundRequestSchema>

export const apiHealthResultSchema = messageResultSchema(healthReportSchema)

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
