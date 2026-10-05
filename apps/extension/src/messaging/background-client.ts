import type { HealthReport } from '@contextlayer/shared'
import type { z } from 'zod'

import {
  apiHealthResultSchema,
  connectionStatusResultSchema,
  disconnectResultSchema,
  failure,
  type BackgroundRequest,
  type ConnectionStatusData,
  type MessageResult,
} from './protocol'

/**
 * Sends a request to the background service worker and validates the reply.
 * Used by the popup and by content scripts: neither ever calls the API directly.
 */
export async function sendToBackground<T>(
  request: BackgroundRequest,
  resultSchema: z.ZodType<MessageResult<T>>,
): Promise<MessageResult<T>> {
  try {
    const response: unknown = await chrome.runtime.sendMessage(request)
    const parsed = resultSchema.safeParse(response)
    return parsed.success
      ? parsed.data
      : failure('INTERNAL_ERROR', 'Unexpected response from the service worker.')
  } catch {
    // e.g. "Extension context invalidated" after the extension was reloaded.
    return failure('INTERNAL_ERROR', 'The extension service worker is not reachable.')
  }
}

export function requestApiHealth(): Promise<MessageResult<HealthReport>> {
  return sendToBackground({ type: 'api.health.get' }, apiHealthResultSchema)
}

export function requestConnectionStatus(): Promise<MessageResult<ConnectionStatusData>> {
  return sendToBackground({ type: 'connection.status' }, connectionStatusResultSchema)
}

export function startConnection(): Promise<MessageResult<ConnectionStatusData>> {
  return sendToBackground({ type: 'connection.start' }, connectionStatusResultSchema)
}

export function cancelConnection(): Promise<MessageResult<ConnectionStatusData>> {
  return sendToBackground({ type: 'connection.cancel' }, connectionStatusResultSchema)
}

export function disconnect(): Promise<MessageResult<{ serverConfirmed: boolean }>> {
  return sendToBackground({ type: 'connection.disconnect' }, disconnectResultSchema)
}
