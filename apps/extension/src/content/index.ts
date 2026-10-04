/**
 * Content script. Runs in an isolated JavaScript world inside the host page:
 * it shares the DOM with the page but not its globals, and it never holds
 * credentials or calls the API itself.
 *
 * The message listener is registered first and nothing touches the DOM at load
 * time, so a hostile or broken page cannot prevent the script from answering.
 */
import { EXTENSION_VERSION } from '../config'
import { logger } from '../lib/logger'
import { requestApiHealth } from '../messaging/background-client'
import { failure } from '../messaging/protocol'
import { handleContentMessage } from './handle-message'
import { createOverlay } from './overlay'

const overlay = createOverlay(document)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension itself (popup, service worker) may drive the content script.
  if (sender.id !== chrome.runtime.id) return false

  void handleContentMessage(message, {
    extensionVersion: EXTENSION_VERSION,
    getPage: () => ({ url: location.href, title: document.title }),
    requestApiHealth,
    showToast: (text) => {
      try {
        overlay.showToast(text)
      } catch (error) {
        // Feedback on the page is best effort; the reply must still be sent.
        logger.warn('could not show the on-page toast', error)
      }
    },
  })
    .catch(() => failure('INTERNAL_ERROR', 'Unexpected error while handling the message.'))
    .then(sendResponse)

  return true
})
