import {
  contentRequestSchema,
  failure,
  pageInfoResultSchema,
  type MessageResult,
  type PageInfo,
} from '../messaging/protocol'

const NOT_RUNNING = failure(
  'NOT_AVAILABLE',
  'ContextLayer is not running in this tab yet. Reload the page and try again.',
)

/** The tab the popup was opened on, if Chrome lets the extension see it. */
export async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id
}

/**
 * Pings the content script of a tab. A missing or inactive receiver (the page
 * was open before the site was enabled and could not be injected, or it was
 * refused) is an expected state, not an error.
 */
export async function pingTab(tabId: number): Promise<MessageResult<PageInfo>> {
  try {
    const response: unknown = await chrome.tabs.sendMessage(
      tabId,
      contentRequestSchema.parse({ type: 'page.ping' }),
    )
    const parsed = pageInfoResultSchema.safeParse(response)
    return parsed.success ? parsed.data : NOT_RUNNING
  } catch {
    return NOT_RUNNING
  }
}
