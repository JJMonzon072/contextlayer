import type { PlayerStep } from '../messaging/protocol'
import { failure, success, type MessageResult } from '../messaging/result'
import { readContentRequest } from './messages'

/** What a page ping answers (mirrors `pageInfoSchema` in the protocol). */
export interface PageInfo {
  url: string
  title: string
  extensionVersion: string
}

export interface ContentDeps {
  extensionVersion: string
  /** True once the worker authorized this page; until then nothing is shown or answered. */
  isActive: () => boolean
  getPage: () => { url: string; title: string }
  showToast: (text: string) => void
  /** Stops the script for good: listeners removed, UI removed. */
  stop: () => void
  /** Starts picking for this capture request (replacing any picker still running). */
  startPicker: (captureId: string, ttlMs: number) => void
  /** Stops the picker if it still serves this capture request. */
  stopPicker: (captureId: string) => void
  /** Previews a step on the element selected under this request; false when it is gone. */
  showPreview: (captureId: string, title: string, lines: string[]) => boolean
  hidePreview: () => void
  /** Shows a step of a running guide; false when it cannot be shown (Edit Mode is selecting). */
  showPlayer: (step: PlayerStep) => boolean
  /** Removes the guide's UI if that run is the one shown. */
  hidePlayer: (runId: string) => void
  /** Moves the focus to the guide's card; false when no guide is shown. */
  focusPlayer: () => boolean
}

export interface ContentSender {
  /** True when the service worker sent the message (not the popup, not a panel). */
  fromWorker: boolean
}

/**
 * Handles messages from the extension (popup, service worker) to the content
 * script. The content script holds no credentials and never calls the API.
 * Capture, preview and player requests are accepted from the service worker
 * only: it is the one that checked the session or the run and created its id.
 */
export function handleContentMessage(
  message: unknown,
  sender: ContentSender,
  deps: ContentDeps,
): MessageResult<PageInfo | { shown: boolean } | { focused: boolean } | null> {
  const request = readContentRequest(message)
  if (!request) {
    return failure('BAD_REQUEST', 'Unsupported message.')
  }

  switch (request.type) {
    case 'page.deactivate':
      deps.stop()
      return success(null)
    case 'page.ping':
      if (!deps.isActive()) return failure('NOT_AVAILABLE', 'ContextLayer is not active here.')
      deps.showToast('ContextLayer is active on this page.')
      return success({ ...deps.getPage(), extensionVersion: deps.extensionVersion })
    case 'picker.start':
    case 'picker.stop':
      if (!sender.fromWorker) return failure('FORBIDDEN', 'Only the extension may start a capture.')
      if (!deps.isActive()) return failure('NOT_AVAILABLE', 'ContextLayer is not active here.')
      if (request.type === 'picker.start') deps.startPicker(request.captureId, request.ttlMs)
      else deps.stopPicker(request.captureId)
      return success(null)
    case 'preview.show':
      if (!sender.fromWorker) return failure('FORBIDDEN', 'Only the extension may show a preview.')
      if (!deps.isActive()) return failure('NOT_AVAILABLE', 'ContextLayer is not active here.')
      return success({ shown: deps.showPreview(request.captureId, request.title, request.lines) })
    case 'preview.hide':
      deps.hidePreview()
      return success(null)
    case 'player.show':
      if (!sender.fromWorker) return failure('FORBIDDEN', 'Only the extension may play a guide.')
      if (!deps.isActive()) return failure('NOT_AVAILABLE', 'ContextLayer is not active here.')
      return success({ shown: deps.showPlayer(request.step) })
    case 'player.hide':
      if (!sender.fromWorker) return failure('FORBIDDEN', 'Only the extension may end a guide.')
      deps.hidePlayer(request.runId)
      return success(null)
    case 'player.focus':
      if (!sender.fromWorker) return failure('FORBIDDEN', 'Only the extension may move the focus.')
      if (!deps.isActive()) return failure('NOT_AVAILABLE', 'ContextLayer is not active here.')
      return success({ focused: deps.focusPlayer() })
  }
}
