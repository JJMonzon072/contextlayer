/**
 * Background service worker: the extension's single gateway to the API.
 *
 * MV3 service workers are terminated when idle, so state lives in
 * chrome.storage, not in module variables. Listeners are registered
 * synchronously at the top level so Chrome can wake the worker for them; each
 * handler awaits the storage restriction before touching credentials. Dynamic
 * `import()` is not supported in extension service workers.
 */
import { API_BASE_URL, DASHBOARD_ORIGIN, EXTENSION_VERSION } from '../config'
import { logger } from '../lib/logger'
import { CONNECTION_CHANGED, failure } from '../messaging/protocol'
import { createApiClient, fetchApiHealth } from './api-client'
import { createAuth } from './auth'
import { createConnectionManager } from './connection'
import { handleBackgroundMessage } from './handle-message'
import { chromeStorage } from './storage'
import { createVault } from './vault'

const vault = createVault(chromeStorage())
const api = createApiClient(API_BASE_URL)
const now = () => Date.now()

/** Tells open extension pages (the popup) to ask for the status again. */
function broadcastChange(): void {
  // Rejects when no extension page is open: nothing to tell.
  chrome.runtime.sendMessage(CONNECTION_CHANGED).catch(() => undefined)
}

const onConnectionChanged = () => {
  broadcastChange()
  return Promise.resolve()
}
const auth = createAuth({ vault, api, now, onEnded: onConnectionChanged })
const connection = createConnectionManager({
  vault,
  auth,
  api,
  openTab: async (url) => (await chrome.tabs.create({ url })).id,
  dashboardOrigin: DASHBOARD_ORIGIN,
  extensionId: chrome.runtime.id,
  now,
  onChanged: onConnectionChanged,
})

// Restrict chrome.storage.local before anything can write a credential to it.
void vault.ready().then((restricted) => {
  if (!restricted)
    logger.warn('storage.local could not be restricted; credentials are session-only')
})

chrome.runtime.onInstalled.addListener(({ reason }) => {
  logger.info(`installed (${reason}), version ${EXTENSION_VERSION}`)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleBackgroundMessage(message, sender, {
    extensionId: chrome.runtime.id,
    fetchApiHealth: () => fetchApiHealth(api),
    connection,
    onApiError: (error) => {
      logger.warn('API request failed', error)
    },
  })
    .catch(() => failure('INTERNAL_ERROR', 'Unexpected error while handling the message.'))
    .then(sendResponse)

  // Keep the message channel open for the asynchronous response.
  return true
})

// The dashboard hands over the connection code (externally_connectable).
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void connection
    .handleExternal(message, sender)
    .catch(() => ({ ok: false, error: 'invalid-request' }) as const)
    .then((response) => {
      sendResponse(response)
      broadcastChange()
    })
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void connection.tabClosed(tabId).then(broadcastChange)
})
