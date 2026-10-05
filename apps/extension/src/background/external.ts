/** The dashboard page that completes a connection (apps/dashboard route `/extension/connect`). */
export const CONNECT_PATH = '/extension/connect'

export type ExternalSender = Pick<
  chrome.runtime.MessageSender,
  'id' | 'origin' | 'url' | 'frameId' | 'documentLifecycle' | 'tab'
>

export type SenderRejection = 'extension' | 'origin' | 'frame' | 'document' | 'tab' | 'url'

/**
 * Who may complete or cancel a connection, from the fields Chrome fills in
 * (never from the payload). Measured in Chromium 153: a web page sender has no
 * `id`, an exact `origin`, `frameId` 0 in the top frame, `documentLifecycle`
 * "active" and the tab. Anything else is refused, including a missing field.
 * Origins are compared exactly: no prefix, suffix or substring matching.
 */
export function checkExternalSender(
  sender: ExternalSender,
  expected: { dashboardOrigin: string; tabId: number | null },
): SenderRejection | undefined {
  if (sender.id !== undefined) return 'extension'
  if (sender.origin !== expected.dashboardOrigin) return 'origin'
  if (sender.frameId !== 0) return 'frame'
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') {
    return 'document'
  }
  if (expected.tabId === null || sender.tab?.id !== expected.tabId) return 'tab'
  const url = sender.url !== undefined && URL.canParse(sender.url) ? new URL(sender.url) : undefined
  if (url?.origin !== expected.dashboardOrigin || url.pathname !== CONNECT_PATH) return 'url'
  return undefined
}
