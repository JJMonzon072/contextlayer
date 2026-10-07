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
 * 4. In Edit Mode the worker sends `picker.start` with a capture request id;
 *    the selected element is described here (`capture/`) and sent back to the
 *    worker for that request only. The element itself stays in this script's
 *    memory, for the step preview, and is never sent anywhere.
 * 5. When a guide plays, the worker sends `player.show` with one step; the
 *    target is resolved and shown here (`player/`, `resolve/`), and the card's
 *    buttons ask the worker for the next step. Same-document navigation shows
 *    the step again for the new URL (`navigation.ts`, ADR 0019). Edit Mode and the player never
 *    overlap: selecting or previewing removes the guide, and a guide is not
 *    shown while selecting or previewing.
 */
import { EXTENSION_VERSION } from '../config'
import { failure } from '../messaging/result'
import { captureTarget, type CaptureContext } from './capture/descriptor'
import { handleContentMessage } from './handle-message'
import { askWorker, readHelloAnswer, readResumeAnswer } from './messages'
import { followNavigation } from './navigation'
import { createOverlay, OVERLAY_HOST_ATTRIBUTE } from './overlay'
import { startPicker, type Picker } from './picker'
import { createPlayer } from './player/player'
import { showPreview, type Preview } from './preview'

type ContentState = 'starting' | 'active' | 'inactive' | 'stopped'

/** Kept on the isolated world's global: invisible to the page's own scripts. */
interface ContentInstance {
  state: ContentState
  /** How many times the script was injected into this world (tests check for duplicates). */
  injections: number
}

const GUARD = '__contextlayerContent'
const scope = globalThis as typeof globalThis & { [GUARD]?: ContentInstance }
/** Elements kept for previews; older selections are forgotten. */
const MAX_REMEMBERED = 50

function captureContext(): CaptureContext {
  const chromeMajor = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1])
  return {
    extensionVersion: EXTENSION_VERSION,
    capturedAt: new Date(),
    href: location.href,
    viewport: {
      width: Math.max(1, Math.round(innerWidth)),
      height: Math.max(1, Math.round(innerHeight)),
      devicePixelRatio: Math.min(Math.max(devicePixelRatio, 0.1), 10),
    },
    ...(chromeMajor >= 100 && chromeMajor <= 999 && { chromeMajor }),
  }
}

/** A host whose shadow root is closed: its contents are out of Phase 5's reach. */
function hasClosedShadowRoot(element: Element): boolean {
  try {
    return chrome.dom.openOrClosedShadowRoot(element as HTMLElement) !== null
  } catch {
    return false
  }
}

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
  let picker: { captureId: string; instance: Picker } | undefined
  let preview: Preview | undefined
  const remembered = new Map<string, WeakRef<Element>>()
  const player = createPlayer({ window, overlay, send: askWorker })
  // Same-document navigation: the step shown follows the URL (ADR 0019).
  const stopFollowing = followNavigation(window, () => {
    player.urlChanged()
  })

  function hidePreview() {
    preview?.stop()
    preview = undefined
  }

  /** The element selected under this request, if this page still holds it. */
  function previewStep(captureId: string, title: string, lines: string[]): boolean {
    hidePreview()
    stopCapture()
    player.stop()
    const element = remembered.get(captureId)?.deref()
    if (!element) return false
    preview = showPreview({
      window,
      overlay,
      element,
      title,
      lines,
      onClose: () => {
        preview = undefined
      },
    })
    return preview !== undefined
  }

  function startCapture(captureId: string, ttlMs: number) {
    hidePreview()
    player.stop()
    picker?.instance.stop()
    const instance = startPicker({
      window,
      overlay,
      ttlMs,
      isAlive: contextAlive,
      onPick: (hit) => {
        if (picker?.captureId === captureId) picker = undefined
        let outcome
        try {
          outcome = captureTarget(hit, captureContext(), hasClosedShadowRoot)
        } catch {
          outcome = { ok: false, reason: 'This element could not be described.' } as const
        }
        if (outcome.ok) {
          remembered.set(captureId, new WeakRef(outcome.element))
          for (const key of remembered.keys()) {
            if (remembered.size <= MAX_REMEMBERED) break
            remembered.delete(key)
          }
        }
        void askWorker({
          type: 'picker.result',
          captureId,
          outcome: outcome.ok
            ? { ok: true, descriptor: outcome.descriptor }
            : { ok: false, reason: outcome.reason },
        })
      },
      onCancel: (reason) => {
        if (picker?.captureId === captureId) picker = undefined
        void askWorker({ type: 'picker.cancelled', captureId, reason })
      },
    })
    picker = { captureId, instance }
  }

  function stopCapture(captureId?: string) {
    if (captureId !== undefined && picker?.captureId !== captureId) return
    picker?.instance.stop()
    picker = undefined
  }

  function stop(state: 'inactive' | 'stopped' = 'stopped') {
    if (instance.state === 'stopped' || instance.state === 'inactive') return
    instance.state = state
    stopCapture()
    hidePreview()
    player.stop()
    stopFollowing()
    remembered.clear()
    overlay.destroy()
    document.removeEventListener('visibilitychange', checkContext)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('pagehide', onPageHide)
    if (contextAlive()) chrome.runtime.onMessage.removeListener(onMessage)
  }

  function checkContext() {
    if (!contextAlive()) stop()
  }

  /** Into bfcache: the guide's UI and waits go now; the document may come back (ADR 0019). */
  function onPageHide(event: PageTransitionEvent) {
    if (event.persisted) player.suspend()
  }

  /**
   * Back from bfcache: the same document and this same script, not run again.
   * It says hello again, so the worker records this document for the tab and
   * checks the site is still on, then asks for the tab's guide.
   */
  function onPageShow(event: PageTransitionEvent) {
    checkContext()
    if (event.persisted && instance.state === 'active') void helloAgain()
  }

  async function helloAgain() {
    const active = readHelloAnswer(await askWorker({ type: 'page.hello' }))
    if (instance.state !== 'active') return
    if (active === true) await resumeGuide()
    else if (active === false) stop('inactive')
    else checkContext()
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
      // Set by Chrome: the worker's script URL, not a value the sender chooses.
      const fromWorker = sender.url === chrome.runtime.getURL('background.js')
      response = handleContentMessage(
        message,
        { fromWorker },
        {
          extensionVersion: EXTENSION_VERSION,
          isActive: () => instance.state === 'active',
          getPage: () => ({ url: location.href, title: document.title }),
          showToast: (text) => {
            overlay.showToast(text)
          },
          stop: () => {
            stop()
          },
          startPicker: startCapture,
          stopPicker: stopCapture,
          showPreview: previewStep,
          hidePreview,
          // Never over Edit Mode's selection or preview.
          showPlayer: (step) => picker === undefined && preview === undefined && player.show(step),
          hidePlayer: (runId) => {
            player.hide(runId)
          },
          focusPlayer: () => player.focus(),
        },
      )
    } catch {
      response = failure('INTERNAL_ERROR', 'Unexpected error while handling the message.')
    }
    sendResponse(response)
    return false
  }

  chrome.runtime.onMessage.addListener(onMessage)
  document.addEventListener('visibilitychange', checkContext)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('pagehide', onPageHide)

  /**
   * Asks for this tab's guide, if one is playing: a link, a form, a reload or
   * bfcache brought this document, and the run continues here (ADR 0019).
   */
  async function resumeGuide() {
    const step = readResumeAnswer(await askWorker({ type: 'player.resume' }))
    if (!step || instance.state !== 'active') return
    // Never over Edit Mode's selection or preview.
    if (picker === undefined && preview === undefined) player.show(step)
  }

  void askWorker({ type: 'page.hello' }).then((answer) => {
    if (instance.state !== 'starting') return
    if (readHelloAnswer(answer) === true) {
      instance.state = 'active'
      void resumeGuide()
    }
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
