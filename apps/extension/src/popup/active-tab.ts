import {
  contentRequestSchema,
  failure,
  pageInfoResultSchema,
  type MessageResult,
  type PageInfo,
} from '../messaging/protocol'

const NOT_AVAILABLE = failure(
  'NOT_AVAILABLE',
  'ContextLayer is not running on this page. In Phase 1 it only runs on the local dashboard (localhost:5173 and :4173).',
)

/**
 * Pings the content script of the active tab. A missing receiver (restricted
 * page, non-matching URL, tab opened before the extension was installed) is an
 * expected state, not an error.
 */
export async function pingActiveTab(): Promise<MessageResult<PageInfo>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) return NOT_AVAILABLE

  try {
    const response: unknown = await chrome.tabs.sendMessage(
      tab.id,
      contentRequestSchema.parse({ type: 'page.ping' }),
    )
    const parsed = pageInfoResultSchema.safeParse(response)
    return parsed.success ? parsed.data : NOT_AVAILABLE
  } catch {
    return NOT_AVAILABLE
  }
}
