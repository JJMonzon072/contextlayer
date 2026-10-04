/**
 * Background service worker: the extension's single gateway to the API.
 *
 * MV3 service workers are terminated when idle, so no state is kept in module
 * variables between events. Listeners are registered synchronously at the top
 * level so Chrome can wake the worker for them. Dynamic `import()` is not
 * supported in extension service workers: use static imports only.
 */
import { EXTENSION_VERSION } from '../config'
import { logger } from '../lib/logger'
import { failure } from '../messaging/protocol'
import { fetchApiHealth } from './api-client'
import { handleBackgroundMessage } from './handle-message'

chrome.runtime.onInstalled.addListener(({ reason }) => {
  logger.info(`installed (${reason}), version ${EXTENSION_VERSION}`)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleBackgroundMessage(message, sender, {
    extensionId: chrome.runtime.id,
    fetchApiHealth: () => fetchApiHealth(),
    onApiError: (error) => {
      logger.warn('API request failed', error)
    },
  })
    .catch(() => failure('INTERNAL_ERROR', 'Unexpected error while handling the message.'))
    .then(sendResponse)

  // Keep the message channel open for the asynchronous response.
  return true
})
