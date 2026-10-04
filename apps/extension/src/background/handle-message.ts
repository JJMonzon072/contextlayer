import type { HealthReport } from '@contextlayer/shared'

import {
  backgroundRequestSchema,
  failure,
  success,
  type MessageResult,
} from '../messaging/protocol'

export interface BackgroundDeps {
  extensionId: string
  fetchApiHealth: () => Promise<HealthReport>
  onApiError?: (error: unknown) => void
}

/**
 * Routes a runtime message received by the service worker. Kept free of
 * `chrome.*` calls so it can be unit-tested with plain inputs.
 */
export async function handleBackgroundMessage(
  message: unknown,
  sender: Pick<chrome.runtime.MessageSender, 'id'>,
  deps: BackgroundDeps,
): Promise<MessageResult<unknown>> {
  if (sender.id !== deps.extensionId) {
    return failure('FORBIDDEN', 'Messages are only accepted from this extension.')
  }

  const request = backgroundRequestSchema.safeParse(message)
  if (!request.success) {
    return failure('BAD_REQUEST', 'Unsupported message.')
  }

  // `api.health.get` is the only request in Phase 1. New request types extend
  // the discriminated union and turn this into a `switch` on `request.data.type`.
  try {
    return success(await deps.fetchApiHealth())
  } catch (error) {
    deps.onApiError?.(error)
    return failure('API_UNREACHABLE', 'The ContextLayer API could not be reached.')
  }
}
