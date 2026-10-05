import {
  contentRequestSchema,
  failure,
  success,
  type MessageResult,
  type PageInfo,
} from '../messaging/protocol'

export interface ContentDeps {
  extensionVersion: string
  /** True once the worker authorized this page; until then nothing is shown or answered. */
  isActive: () => boolean
  getPage: () => { url: string; title: string }
  showToast: (text: string) => void
  /** Stops the script for good: listeners removed, UI removed. */
  stop: () => void
}

/**
 * Handles messages from the extension (popup, service worker) to the content
 * script. The content script holds no credentials and never calls the API.
 */
export function handleContentMessage(
  message: unknown,
  deps: ContentDeps,
): MessageResult<PageInfo | null> {
  const request = contentRequestSchema.safeParse(message)
  if (!request.success) {
    return failure('BAD_REQUEST', 'Unsupported message.')
  }

  switch (request.data.type) {
    case 'page.deactivate':
      deps.stop()
      return success(null)
    case 'page.ping':
      if (!deps.isActive()) return failure('NOT_AVAILABLE', 'ContextLayer is not active here.')
      deps.showToast('ContextLayer is active on this page.')
      return success({ ...deps.getPage(), extensionVersion: deps.extensionVersion })
  }
}
