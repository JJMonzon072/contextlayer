import type { HealthReport } from '@contextlayer/shared'

import {
  contentRequestSchema,
  failure,
  success,
  type MessageResult,
  type PageInfo,
} from '../messaging/protocol'

export interface ContentDeps {
  extensionVersion: string
  getPage: () => { url: string; title: string }
  requestApiHealth: () => Promise<MessageResult<HealthReport>>
  showToast: (text: string) => void
}

const TOAST_BY_API_STATUS: Record<PageInfo['api'], string> = {
  ok: 'ContextLayer is active on this page.',
  unavailable: 'ContextLayer is active, but the API reports a problem.',
  unreachable: 'ContextLayer is active, but the API is unreachable.',
}

/**
 * Handles messages addressed to the content script. The API is only reached
 * through the background service worker (`requestApiHealth`).
 */
export async function handleContentMessage(
  message: unknown,
  deps: ContentDeps,
): Promise<MessageResult<PageInfo>> {
  const request = contentRequestSchema.safeParse(message)
  if (!request.success) {
    return failure('BAD_REQUEST', 'Unsupported message.')
  }

  // `page.ping` is the only request in Phase 1 (see the background handler).
  const health = await deps.requestApiHealth()
  const api: PageInfo['api'] = !health.ok
    ? 'unreachable'
    : health.data.status === 'ok'
      ? 'ok'
      : 'unavailable'

  deps.showToast(TOAST_BY_API_STATUS[api])
  return success({ ...deps.getPage(), extensionVersion: deps.extensionVersion, api })
}
