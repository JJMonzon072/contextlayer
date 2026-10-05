import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test'

import { E2E_DASHBOARD_URL } from '../environment'
import { openPopupTab } from '../fixtures'
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
