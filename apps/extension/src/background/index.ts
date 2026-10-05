/**
 * Background service worker: the extension's single gateway to the API.
 *
 * MV3 service workers are terminated when idle, so state lives in
 * chrome.storage, not in module variables. Listeners are registered
 * synchronously at the top level so Chrome can wake the worker for them; each
 * handler awaits the storage restriction before touching credentials. Dynamic
 * `import()` is not supported in extension service workers.
 */
import { originMatchPattern } from '@contextlayer/shared'

import { API_BASE_URL, DASHBOARD_ORIGIN, EXTENSION_VERSION } from '../config'
import { logger } from '../lib/logger'
import { CONNECTION_CHANGED, failure } from '../messaging/protocol'
import { createApiClient, fetchApiHealth } from './api-client'
import { createAuth } from './auth'
import { createConnectionManager } from './connection'
import { handleBackgroundMessage } from './handle-message'
import { createSiteAccess, type SiteChrome } from './site-access'
import { chromeStorage } from './storage'
import { createVault } from './vault'

const vault = createVault(chromeStorage())
const api = createApiClient(API_BASE_URL)
const now = () => Date.now()
const apiPattern = originMatchPattern(API_BASE_URL)

const siteChrome: SiteChrome = {
  hasHostAccess: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
  removeHostAccess: (pattern) =>
    chrome.permissions.remove({ origins: [pattern] }).catch(() => false),
  tabUrl: async (tabId) => (await chrome.tabs.get(tabId).catch(() => undefined))?.url,
  registeredScripts: () => chrome.scripting.getRegisteredContentScripts(),
  registerScripts: (scripts) =>
    chrome.scripting.registerContentScripts(
      scripts.map(({ id, pattern }) => ({
        id,
        matches: [pattern],
        js: ['content.js'],
        runAt: 'document_idle',
        // Top frames only: guides are for the application, not for embedded widgets.
        allFrames: false,
        persistAcrossSessions: true,
      })),
    ),
  unregisterScripts: (ids) => chrome.scripting.unregisterContentScripts({ ids }),
  tabsMatching: async (pattern) =>
    (await chrome.tabs.query({ url: pattern })).flatMap((tab) =>
      tab.id === undefined ? [] : [tab.id],
    ),
  inject: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  },
  sendToTab: async (tabId, message, documentId) => {
    await chrome.tabs.sendMessage(tabId, message, { documentId })
  },
}

/** Tells open extension pages (the popup) to ask for the status again. */
function broadcastChange(): void {
  // Rejects when no extension page is open: nothing to tell.
  chrome.runtime.sendMessage(CONNECTION_CHANGED).catch(() => undefined)
}

function reconcileSites(options?: { injectAll?: boolean }): void {
  site.reconcile(options).catch((error: unknown) => {
    logger.warn('could not reconcile site access', error)
  })
}

// Not awaited: a reconcile may itself end the connection and call this again.
const onConnectionChanged = () => {
  broadcastChange()
  reconcileSites()
  return Promise.resolve()
}
const auth = createAuth({ vault, api, now, onEnded: onConnectionChanged })
const site = createSiteAccess({ vault, auth, chrome: siteChrome, apiPattern, now })
const connection = createConnectionManager({
  vault,
  auth,
  api,
  openTab: async (url) => (await chrome.tabs.create({ url })).id,
  apiAccess: () => siteChrome.hasHostAccess(apiPattern),
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

// Install, update, reload and browser start: registrations may be gone (the
// spike saw them disappear) and open tabs hold orphaned scripts, so every
// enabled site is registered and injected again.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  logger.info(`installed (${reason}), version ${EXTENSION_VERSION}`)
  reconcileSites({ injectAll: true })
})
chrome.runtime.onStartup.addListener(() => {
  reconcileSites({ injectAll: true })
})

// The user (or Chrome) granted or withdrew host access, including from
// chrome://extensions: scripts follow the grant, and the popup is refreshed.
chrome.permissions.onAdded.addListener(() => {
  reconcileSites()
  broadcastChange()
})
chrome.permissions.onRemoved.addListener(() => {
  reconcileSites()
  broadcastChange()
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleBackgroundMessage(message, sender, {
    extensionId: chrome.runtime.id,
    fetchApiHealth: () => fetchApiHealth(api),
    connection,
    site,
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
  void site.pageClosed(tabId)
})
