/**
 * Message results, shared by every context. Kept free of zod so the content
 * script, which is injected into every enabled page, can use it without
 * shipping a schema library (content-script budget, `scripts/budget.ts`).
 */
export const MESSAGE_ERROR_CODES = [
  'BAD_REQUEST',
  'FORBIDDEN',
  'API_UNREACHABLE',
  'NOT_AVAILABLE',
  'INTERNAL_ERROR',
  // Edit Mode (Phase 5).
  'NOT_FOUND',
  /** The guide changed on the server since it was loaded (revision), or it is archived. */
  'CONFLICT',
  /** The answer belongs to an older connection, session, guide or request: ignore it. */
  'STALE',
  /** The page the session was bound to was reloaded or left: continue explicitly. */
  'PAGE_CHANGED',
  /** A save was sent but its answer was lost: reload the guide before deciding. */
  'OUTCOME_UNKNOWN',
] as const

export interface MessageError {
  code: (typeof MESSAGE_ERROR_CODES)[number]
  message: string
}

/**
 * Responses are explicit results instead of thrown errors: exceptions do not
 * cross `chrome.runtime` message boundaries in a useful way.
 */
export type MessageResult<T> = { ok: true; data: T } | { ok: false; error: MessageError }

export function success<T>(data: T): MessageResult<T> {
  return { ok: true, data }
}

export function failure(code: MessageError['code'], message: string): MessageResult<never> {
  return { ok: false, error: { code, message } }
}
