/**
 * The content script's side of the message protocol, without zod: this file
 * ships in every enabled page, so it uses small hand-written readers instead
 * of the schema library (content-script budget, `scripts/budget.ts`). The
 * readers mirror the zod schemas in `src/messaging/protocol.ts`, which stay
 * authoritative for the worker and the extension pages;
 * `test/content-messages.test.ts` checks that both accept and refuse the same
 * inputs.
 */
import { failure, type MessageResult } from '../messaging/result'

export type ContentRequest = { type: 'page.ping' } | { type: 'page.deactivate' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Exactly these keys, like a zod strict object. */
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

/** A request from the extension to this content script, or undefined. */
export function readContentRequest(value: unknown): ContentRequest | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['type'])) return undefined
  if (value.type === 'page.ping' || value.type === 'page.deactivate') return { type: value.type }
  return undefined
}

/**
 * The worker's answer to `page.hello`: `true` or `false` for a well-formed
 * success, `undefined` for a failure or anything malformed.
 */
export function readHelloAnswer(value: unknown): boolean | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return undefined
  return typeof value.data.active === 'boolean' ? value.data.active : undefined
}

/** Sends a message to the service worker; an unreachable worker is an answer, not an error. */
export async function askWorker(message: object): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    // e.g. "Extension context invalidated" after the extension was reloaded.
    return failure('INTERNAL_ERROR', 'The extension service worker is not reachable.')
  }
}

export type { MessageResult }
