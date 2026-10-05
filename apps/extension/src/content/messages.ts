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

export type ContentRequest =
  | { type: 'page.ping' }
  | { type: 'page.deactivate' }
  | { type: 'picker.start'; captureId: string; ttlMs: number }
  | { type: 'picker.stop'; captureId: string }
  | { type: 'preview.show'; captureId: string; title: string; lines: string[] }
  | { type: 'preview.hide' }

/** Mirrors `PICKER_TTL_MS`, `captureIdSchema` and `previewTextSchema` in the protocol. */
const PICKER_TTL_MS = 120_000
const CAPTURE_ID = /^[A-Za-z0-9_-]{16,64}$/
const PREVIEW_MAX_LINES = 40

const isPreviewText = (title: unknown, lines: unknown): lines is string[] =>
  typeof title === 'string' &&
  title.length <= 120 &&
  Array.isArray(lines) &&
  lines.length <= PREVIEW_MAX_LINES &&
  lines.every((line) => typeof line === 'string' && line.length <= 2_000)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Exactly these keys, like a zod strict object. */
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

/** A request from the extension to this content script, or undefined. */
export function readContentRequest(value: unknown): ContentRequest | undefined {
  if (!isRecord(value)) return undefined
  const { type, captureId, ttlMs, title, lines } = value
  if (type === 'page.ping' || type === 'page.deactivate' || type === 'preview.hide') {
    return hasOnlyKeys(value, ['type']) ? { type } : undefined
  }
  if (typeof captureId !== 'string' || !CAPTURE_ID.test(captureId)) return undefined
  if (type === 'picker.stop' && hasOnlyKeys(value, ['type', 'captureId'])) {
    return { type, captureId }
  }
  if (
    type === 'preview.show' &&
    hasOnlyKeys(value, ['type', 'captureId', 'title', 'lines']) &&
    isPreviewText(title, lines)
  ) {
    return { type, captureId, title: title as string, lines: [...lines] }
  }
  if (
    type === 'picker.start' &&
    hasOnlyKeys(value, ['type', 'captureId', 'ttlMs']) &&
    typeof ttlMs === 'number' &&
    Number.isInteger(ttlMs) &&
    ttlMs >= 1_000 &&
    ttlMs <= PICKER_TTL_MS
  ) {
    return { type, captureId, ttlMs }
  }
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
