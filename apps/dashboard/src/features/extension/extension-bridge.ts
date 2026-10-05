import {
  DEVELOPMENT_EXTENSION_ID,
  extensionExternalResponseSchema,
  type ExtensionExternalMessage,
  type ExtensionExternalResponse,
} from '@contextlayer/shared'

/**
 * The extension this dashboard hands connection codes to: `EXTENSION_ID` at
 * build time, or the id of the committed development key.
 */
export const EXTENSION_ID = __CONTEXTLAYER_EXTENSION_ID__ || DEVELOPMENT_EXTENSION_ID

/** How long the extension may take to exchange the code with the API. */
const ANSWER_TIMEOUT_MS = 20_000

/** What a page can see of `chrome.runtime` when an extension lists its origin in externally_connectable. */
export interface ExternalRuntime {
  sendMessage(extensionId: string, message: unknown): Promise<unknown>
}

export type HandoffResult =
  ExtensionExternalResponse | { ok: false; error: 'extension-missing' | 'no-answer' }

/**
 * `chrome.runtime.sendMessage` only exists in a page when an installed extension
 * accepts messages from this exact origin; otherwise the extension is missing
 * (or built for another dashboard).
 */
export function externalRuntime(): ExternalRuntime | undefined {
  const runtime = (globalThis as { chrome?: { runtime?: Partial<ExternalRuntime> } }).chrome
    ?.runtime
  return typeof runtime?.sendMessage === 'function' ? (runtime as ExternalRuntime) : undefined
}

/**
 * Sends one handoff message to the extension and validates its answer. Only the
 * code and the state ever leave this page; the extension answers with who is
 * connected, never with a token.
 */
export async function sendToExtension(
  message: ExtensionExternalMessage,
  runtime: ExternalRuntime | undefined = externalRuntime(),
  timeoutMs = ANSWER_TIMEOUT_MS,
): Promise<HandoffResult> {
  if (!runtime) return { ok: false, error: 'extension-missing' }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    const answer = await Promise.race([runtime.sendMessage(EXTENSION_ID, message), timeout])
    const parsed = extensionExternalResponseSchema.safeParse(answer)
    return parsed.success ? parsed.data : { ok: false, error: 'no-answer' }
  } catch {
    // e.g. "Could not establish connection": the extension is disabled or reloading.
    return { ok: false, error: 'no-answer' }
  } finally {
    clearTimeout(timer)
  }
}

/** A recognisable name for "Connected browsers", such as "Chrome on macOS". */
export function browserLabel(userAgent: string = navigator.userAgent): string {
  const has = (token: string) => userAgent.includes(token)
  const browser = has('Edg/')
    ? 'Edge'
    : has('OPR/')
      ? 'Opera'
      : has('Chrome/')
        ? 'Chrome'
        : 'Browser'
  const platform = has('Mac OS X')
    ? 'macOS'
    : has('Windows')
      ? 'Windows'
      : has('CrOS')
        ? 'ChromeOS'
        : has('Linux')
          ? 'Linux'
          : undefined
  return platform ? `${browser} on ${platform}` : browser
}
