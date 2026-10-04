import type { HealthReport } from '@contextlayer/shared'

import {
  apiHealthResultSchema,
  failure,
  type BackgroundRequest,
  type MessageResult,
} from './protocol'

/**
 * Asks the background service worker for the API health report. Used by the
 * popup and by content scripts: neither ever calls the API directly.
 */
export async function requestApiHealth(): Promise<MessageResult<HealthReport>> {
  const request: BackgroundRequest = { type: 'api.health.get' }

  try {
    const response: unknown = await chrome.runtime.sendMessage(request)
    const parsed = apiHealthResultSchema.safeParse(response)
    return parsed.success
      ? parsed.data
      : failure('INTERNAL_ERROR', 'Unexpected response from the service worker.')
  } catch {
    // e.g. "Extension context invalidated" after the extension was reloaded.
    return failure('INTERNAL_ERROR', 'The extension service worker is not reachable.')
  }
}
