import type { HealthReport } from '@contextlayer/shared'
import type { z } from 'zod'

import {
  activationCancelResultSchema,
  activationRequestResultSchema,
  apiHealthResultSchema,
  applicationListResultSchema,
  connectionStatusResultSchema,
  disconnectResultSchema,
  failure,
  playerStartResultSchema,
  siteStatusResultSchema,
  type ApplicationListData,
  type BackgroundRequest,
  type ConnectionStatusData,
  type MessageResult,
  type SiteStatusData,
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

export function requestApplications(): Promise<MessageResult<ApplicationListData>> {
  return sendToBackground({ type: 'applications.list' }, applicationListResultSchema)
}

export function requestSiteStatus(tabId: number): Promise<MessageResult<SiteStatusData>> {
  return sendToBackground({ type: 'site.status', tabId }, siteStatusResultSchema)
}

/**
 * Asks the worker to turn ContextLayer on for the tab's site once Chrome grants
 * it. `chrome.runtime.sendMessage` is called synchronously here (before the
 * first await), so a caller can send this and then call
 * `chrome.permissions.request()` in the same task as the user's click.
 */
export function requestActivation(
  tabId: number,
): Promise<MessageResult<{ intentId: string | null }>> {
  return sendToBackground({ type: 'site.requestActivation', tabId }, activationRequestResultSchema)
}

export function cancelActivation(intentId: string): Promise<MessageResult<{ cancelled: boolean }>> {
  return sendToBackground({ type: 'site.cancelActivation', intentId }, activationCancelResultSchema)
}

export function disableSite(tabId: number): Promise<MessageResult<SiteStatusData>> {
  return sendToBackground({ type: 'site.disable', tabId }, siteStatusResultSchema)
}

/** Plays a published guide on the tab: the worker checks the page and the version again. */
export function startGuide(
  tabId: number,
  guideId: string,
  version: number,
): Promise<MessageResult<{ runId: string }>> {
  return sendToBackground(
    { type: 'player.start', tabId, guideId, version },
    playerStartResultSchema,
  )
}
