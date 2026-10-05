/**
 * Content script, registered at runtime for enabled sites only (ADR 0017). It
 * runs in an isolated JavaScript world inside the host page: it shares the DOM
 * with the page but not its globals, and it never holds credentials or calls
 * the API itself.
 *
 * Life cycle:
 * 1. A guard on the isolated world's global makes a second injection into the
 *    same page (registration + injection into an open tab) a no-op.
 * 2. It stays inert until the worker answers `page.hello`: the worker checks
 *    the connection, the site and Chrome's grant from the sender Chrome reports.
 * 3. `page.deactivate` from the extension stops it for good (cooperative
 *    teardown). A copy orphaned by an extension reload or update cannot reach
 *    the extension any more; it notices when the page is shown again or a call
 *    fails, and removes itself.
 */
import { EXTENSION_VERSION } from '../config'
import { sendToBackground } from '../messaging/background-client'
import { failure, helloResultSchema } from '../messaging/protocol'
import { handleContentMessage } from './handle-message'
import { createOverlay, OVERLAY_HOST_ATTRIBUTE } from './overlay'

type ContentState = 'starting' | 'active' | 'inactive' | 'stopped'

/** Kept on the isolated world's global: invisible to the page's own scripts. */
interface ContentInstance {
  state: ContentState
  /** How many times the script was injected into this world (tests check for duplicates). */
  injections: number
}

const GUARD = '__contextlayerContent'
const scope = globalThis as typeof globalThis & { [GUARD]?: ContentInstance }

function start(instance: ContentInstance): void {
  instance.state = 'starting'
  // A host left behind by an orphaned copy (other world, same DOM) is removed.
  for (const stale of document.querySelectorAll(`[${OVERLAY_HOST_ATTRIBUTE}]`)) stale.remove()
  const overlay = createOverlay(document)

  // After an extension reload or update this copy is orphaned: Chrome removes
  // `chrome.runtime.id` (the types say it is always there).
  const contextAlive = () => {
    try {
      return (chrome.runtime as { id?: string } | undefined)?.id !== undefined
    } catch {
      return false
    }
  }

  /** `inactive`: refused by the worker; `stopped`: told to stop or orphaned. Both are silent. */
  function stop(state: 'inactive' | 'stopped' = 'stopped') {
    if (instance.state === 'stopped' || instance.state === 'inactive') return
    instance.state = state
    overlay.destroy()
    document.removeEventListener('visibilitychange', checkContext)
    window.removeEventListener('pageshow', checkContext)
    if (contextAlive()) chrome.runtime.onMessage.removeListener(onMessage)
  }

  function checkContext() {
    if (!contextAlive()) stop()
  }

  function onMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean {
    // Only the extension itself (popup, service worker) may drive the content script.
    if (sender.id !== chrome.runtime.id) return false
    let response
    try {
      response = handleContentMessage(message, {
        extensionVersion: EXTENSION_VERSION,
        isActive: () => instance.state === 'active',
        getPage: () => ({ url: location.href, title: document.title }),
        showToast: (text) => {
          overlay.showToast(text)
        },
        stop: () => {
          stop()
        },
      })
    } catch {
      response = failure('INTERNAL_ERROR', 'Unexpected error while handling the message.')
    }
    sendResponse(response)
    return false
  }

  chrome.runtime.onMessage.addListener(onMessage)
  document.addEventListener('visibilitychange', checkContext)
  window.addEventListener('pageshow', checkContext)

  void sendToBackground({ type: 'page.hello' }, helloResultSchema).then((result) => {
    if (instance.state !== 'starting') return
    if (result.ok && result.data.active) instance.state = 'active'
    // Not authorized, or the worker is unreachable (orphaned copy): stay silent.
    else stop(contextAlive() ? 'inactive' : 'stopped')
  })
}

const existing = scope[GUARD]
if (existing === undefined) {
  const instance: ContentInstance = { state: 'starting', injections: 1 }
  scope[GUARD] = instance
  start(instance)
} else {
  existing.injections += 1
  // A page that was told to stop, or refused, may be enabled again later.
  if (existing.state === 'stopped' || existing.state === 'inactive') start(existing)
}
