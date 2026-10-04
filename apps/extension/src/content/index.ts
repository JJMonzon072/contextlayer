/**
 * Content script. Runs in an isolated JavaScript world inside the host page:
 * it shares the DOM with the page but not its globals, and it never holds
 * credentials or calls the API itself.
 */
import { EXTENSION_VERSION } from '../config'
import { requestApiHealth } from '../messaging/background-client'
import { handleContentMessage } from './handle-message'
import { mountOverlay } from './overlay'

const overlay = mountOverlay(document, EXTENSION_VERSION)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension itself (popup, service worker) may drive the content script.
  if (sender.id !== chrome.runtime.id) return false

  void handleContentMessage(message, {
    extensionVersion: EXTENSION_VERSION,
    getPage: () => ({ url: location.href, title: document.title }),
    requestApiHealth,
    showToast: (text) => {
      overlay.showToast(text)
    },
  }).then(sendResponse)

  return true
})
