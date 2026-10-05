import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test'

import { E2E_DASHBOARD_URL } from '../environment'
import { extensionWorker, openPopupTab, type ExtensionBrowser } from '../fixtures'
import { PASSWORD, type Account } from './api'

/**
 * "Connect to ContextLayer" from the popup, through the real dashboard: sign in
 * when asked, choose the workspace, approve, and wait for the dashboard to
 * report what the extension confirmed.
 */
export async function connectExtension(
  context: BrowserContext,
  account: Account,
  workspaceName: string,
  popup?: Page,
): Promise<{ popup: Page; tab: Page }> {
  popup ??= await openPopupTab(context, DEVELOPMENT_EXTENSION_ID)
  const opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: /^(Connect to ContextLayer|Switch workspace)$/ }).click()
  const tab = await opened
  await approveInDashboard(tab, account, workspaceName)
  await expect(tab.getByTestId('connect-success')).toContainText(workspaceName)
  await expect(popup.getByTestId('connection-workspace')).toHaveText(workspaceName)
  return { popup, tab }
}

/** Signs in if the dashboard asks for it and waits for the connect page. */
export async function signInIfAsked(tab: Page, account: Account): Promise<void> {
  const heading = tab.getByRole('heading', { level: 1, name: /^(Sign in|Connect the extension)$/ })
  await expect(heading).toBeVisible()
  if ((await heading.textContent()) === 'Sign in') {
    await tab.getByLabel('Email').fill(account.email)
    await tab.getByLabel('Password').fill(PASSWORD)
    await tab.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(tab.getByRole('heading', { name: 'Connect the extension' })).toBeVisible()
  expect(new URL(tab.url()).pathname).toBe('/extension/connect')
}

export async function approveInDashboard(
  tab: Page,
  account: Account,
  workspaceName: string,
): Promise<void> {
  await signInIfAsked(tab, account)
  await tab.getByRole('radio', { name: workspaceName }).check()
  await tab.getByRole('button', { name: 'Connect', exact: true }).click()
}

/** Sends a message to the extension from a page, as the dashboard does. */
export function sendExternal(target: Page | ReturnType<Page['mainFrame']>, message: unknown) {
  return target.evaluate(
    ([id, payload]) => chrome.runtime.sendMessage<unknown, unknown>(id, payload),
    [DEVELOPMENT_EXTENSION_ID, message] as const,
  )
}

export async function connectedBrowsers(
  context: BrowserContext,
  workspaceId: string,
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${E2E_DASHBOARD_URL}/workspaces/${workspaceId}/connected-browsers`)
  await expect(page.getByRole('heading', { name: 'Connected browsers' })).toBeVisible()
  return page
}

/**
 * A short SHA-256 fingerprint of a stored credential, computed in the worker:
 * tests compare credentials without the values ever leaving the browser.
 */
export function credentialFingerprint(
  worker: Worker,
  area: 'local' | 'session',
  key: 'cl.refresh' | 'cl.access',
): Promise<string | null> {
  return worker.evaluate(
    async ([storageArea, storageKey]) => {
      const record = (await chrome.storage[storageArea].get(storageKey))[storageKey] as
        { token?: string } | undefined
      if (typeof record?.token !== 'string') return null
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.token))
      return [...new Uint8Array(digest).slice(0, 6)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    },
    [area, key] as const,
  )
}

/**
 * Opens the real toolbar popup (`chrome.action.openPopup`) over `page`, which
 * becomes the active tab of its window. The popup is reached through the
 * browser-level CDP connection: Playwright does not list it as a page.
 * Unlike a click on the toolbar icon, this grants no activeTab, so the popup
 * only sees the address of sites the extension already has access to.
 */
export async function openActionPopup(
  extensionBrowser: ExtensionBrowser,
  page: Page,
): Promise<Page> {
  await page.bringToFront()
  const worker = await extensionWorker(page.context())
  const url = page.url()
  await expect
    .poll(() =>
      worker.evaluate(
        async (target) => (await chrome.tabs.query({ url: target, active: true })).length,
        url,
      ),
    )
    .toBe(1)
  // Chrome refuses to open a second popup while one is open.
  for (const open of await toolbarPopups(extensionBrowser)) await open.close()
  await worker.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target, active: true })
    await chrome.action.openPopup({ windowId: tab?.windowId })
  }, url)
  let popup: Page | undefined
  await expect
    .poll(async () => {
      ;[popup] = await toolbarPopups(extensionBrowser)
      return popup !== undefined
    })
    .toBe(true)
  if (!popup) throw new Error('popup not found')
  await popup.waitForLoadState()
  return popup
}

/** popup.html may also be open in a tab; only the toolbar popup has no tab. */
async function toolbarPopups(extensionBrowser: ExtensionBrowser): Promise<Page[]> {
  const browser = await extensionBrowser.cdp()
  const popups: Page[] = []
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    if (
      candidate.url().endsWith('/popup.html') &&
      (await candidate.evaluate(async () => (await chrome.tabs.getCurrent()) === undefined))
    ) {
      popups.push(candidate)
    }
  }
  return popups
}

export interface ContentScriptState {
  state: 'starting' | 'active' | 'inactive' | 'stopped'
  injections: number
}

/**
 * Reads the content script's own state from its isolated world, through CDP:
 * the page's scripts cannot see it. `null` when the script never ran in that
 * frame. `frame: 'child'` looks at the first subframe instead of the top one.
 */
export async function contentScriptStates(
  page: Page,
  options: { frame?: 'top' | 'child' } = {},
): Promise<(ContentScriptState | null)[]> {
  const session = await page.context().newCDPSession(page)
  try {
    const worlds: { id: number; name: string; auxData?: { frameId?: string; type?: string } }[] = []
    session.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context))
    await session.send('Runtime.enable')
    const { frameTree } = await session.send('Page.getFrameTree')
    const frameId =
      options.frame === 'child' ? frameTree.childFrames?.[0]?.frame.id : frameTree.frame.id
    const ours = worlds.filter(
      (world) =>
        world.name === 'ContextLayer' &&
        world.auxData?.type === 'isolated' &&
        world.auxData.frameId === frameId,
    )
    const states: (ContentScriptState | null)[] = []
    for (const world of ours) {
      const { result } = await session.send('Runtime.evaluate', {
        contextId: world.id,
        expression: 'JSON.stringify(globalThis.__contextlayerContent ?? null)',
        returnByValue: true,
      })
      states.push(JSON.parse(String(result.value)) as ContentScriptState | null)
    }
    return states
  } finally {
    await session.detach()
  }
}

/** The single live content script of the top frame, or null when none ever ran. */
export async function contentScriptState(page: Page): Promise<ContentScriptState | null> {
  const states = await contentScriptStates(page)
  return states.at(-1) ?? null
}

/** Runs an expression inside the content script's isolated world (as the script could). */
export async function evaluateInContentScript(page: Page, expression: string): Promise<unknown> {
  const session = await page.context().newCDPSession(page)
  try {
    const worlds: { id: number; name: string; auxData?: { frameId?: string } }[] = []
    session.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context))
    await session.send('Runtime.enable')
    const { frameTree } = await session.send('Page.getFrameTree')
    const world = worlds.findLast(
      (candidate) =>
        candidate.name === 'ContextLayer' && candidate.auxData?.frameId === frameTree.frame.id,
    )
    if (!world) throw new Error('no ContextLayer content script in this page')
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      contextId: world.id,
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'failed')
    return result.value
  } finally {
    await session.detach()
  }
}

/** Edit Mode side panels currently open (reached through a fresh CDP connection). */
export async function sidePanels(extensionBrowser: ExtensionBrowser): Promise<Page[]> {
  const browser = await extensionBrowser.cdp()
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((candidate) => new URL(candidate.url()).pathname === '/sidepanel.html')
}

/**
 * Opens Edit Mode the way an author does: the real toolbar popup over `page`,
 * then a real click on "Edit Mode", whose user gesture `sidePanel.open()`
 * needs. Returns the side panel's page.
 */
export async function openEditMode(extensionBrowser: ExtensionBrowser, page: Page): Promise<Page> {
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  await popup.getByTestId('edit-mode').click()
  let panel: Page | undefined
  await expect
    .poll(async () => {
      ;[panel] = await sidePanels(extensionBrowser)
      return panel !== undefined
    })
    .toBe(true)
  if (!panel) throw new Error('side panel not found')
  await panel.waitForLoadState()
  return panel
}
