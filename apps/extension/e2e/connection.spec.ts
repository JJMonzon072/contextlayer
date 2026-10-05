import AxeBuilder from '@axe-core/playwright'
import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'
import type { Page } from '@playwright/test'

import { E2E_API_URL, E2E_DASHBOARD_URL, GRANTED_SITE } from './environment'
import {
  expect,
  extensionWorker,
  launchBrowser,
  openPopupTab,
  reloadExtension,
  stopServiceWorker,
  test,
} from './fixtures'
import { createAccount, createWorkspace } from './support/api'
import {
  approveInDashboard,
  connectedBrowsers,
  connectExtension,
  credentialFingerprint,
  sendExternal,
  signInIfAsked,
} from './support/flows'

/**
 * Phase 4 connection flow in real Chromium, with the built dashboard and API.
 * Nothing here bypasses authentication: the extension and the dashboard run
 * their production code; tests only drive the UI, stop the worker through CDP
 * and, for two scenarios, act on the worker's storage the way a crash would.
 */

const CREDENTIAL = /cl[acr]_[A-Za-z0-9_-]{43}/

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(violations).toEqual([])
}

test('connects through the dashboard and shows the account and workspace', async ({ context }) => {
  const account = await createAccount('Alice')
  const workspaceId = await createWorkspace(account, 'Acme')
  await createWorkspace(account, 'Globex')

  const popup = await openPopupTab(context, DEVELOPMENT_EXTENSION_ID)
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected')
  await expectAccessible(popup)

  const opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: 'Connect to ContextLayer' }).click()
  const tab = await opened
  // Signed out: the dashboard asks for a login and keeps the connect link.
  await expect(tab).toHaveURL(/\/login\?redirect=\/extension\/connect\?state=/)
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'connecting')

  await signInIfAsked(tab, account)
  // The verifier never appears in the dashboard URL; only state and challenge do.
  expect([...new URL(tab.url()).searchParams.keys()].sort()).toEqual(['challenge', 'state'])
  await expect(tab.getByTestId('connect-account')).toContainText(account.email)
  // No workspace is preselected: the user must choose.
  await expect(tab.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled()
  await tab.getByRole('radio', { name: 'Acme' }).check()
  await expect(tab.getByTestId('connect-summary')).toContainText('Acme')
  await expectAccessible(tab)
  await tab.getByRole('button', { name: 'Connect', exact: true }).click()

  await expect(tab.getByTestId('connect-success')).toContainText('Acme')
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'connected')
  await expect(popup.getByTestId('connection-user')).toContainText('Alice')
  await expect(popup.getByTestId('connection-workspace')).toHaveText('Acme')
  await expectAccessible(popup)

  // The dashboard page never held an extension credential.
  const dashboardState = await tab.evaluate<string>(
    'JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, document.body.innerHTML])',
  )
  expect(dashboardState).not.toMatch(CREDENTIAL)

  const list = await connectedBrowsers(context, workspaceId)
  await expect(list.getByTestId('connection-row')).toHaveCount(1)
  await expect(list.getByTestId('connection-status')).toHaveText('Active')
})

test('accepts the handoff only from the dashboard tab it opened, once', async ({ context }) => {
  const account = await createAccount()
  await createWorkspace(account, 'Acme')
  const popup = await openPopupTab(context, DEVELOPMENT_EXTENSION_ID)
  const opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: 'Connect to ContextLayer' }).click()
  const tab = await opened
  await signInIfAsked(tab, account)
  const state = new URL(tab.url()).searchParams.get('state')
  const forgedCode = `clc_${'A'.repeat(43)}`

  // A customer site is not externally connectable: no chrome.runtime at all.
  const site = await context.newPage()
  await site.goto(GRANTED_SITE)
  expect(
    await site.evaluate(
      () =>
        typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime
          ?.sendMessage,
    ),
  ).toBe('undefined')

  // Same dashboard origin, but another tab.
  const otherTab = await context.newPage()
  await otherTab.goto(`${E2E_DASHBOARD_URL}/status`)
  expect(
    await sendExternal(otherTab, { type: 'connection.complete', state, code: forgedCode }),
  ).toEqual({ ok: false, error: 'invalid-request' })

  // The right tab, but a subframe.
  await tab.evaluate(
    "document.body.append(Object.assign(document.createElement('iframe'), { src: '/status' }))",
  )
  await expect.poll(() => tab.frames().length).toBe(2)
  const subframe = tab.frames().find((frame) => frame !== tab.mainFrame())
  if (!subframe) throw new Error('subframe missing')
  await subframe.waitForLoadState()
  expect(
    await sendExternal(subframe, { type: 'connection.complete', state, code: forgedCode }),
  ).toEqual({ ok: false, error: 'invalid-request' })

  // The right tab with a guessed state, and messages outside the contract.
  expect(
    await sendExternal(tab, {
      type: 'connection.complete',
      state: 'x'.repeat(43),
      code: forgedCode,
    }),
  ).toEqual({ ok: false, error: 'unknown-attempt' })
  expect(await sendExternal(tab, { type: 'connection.status' })).toEqual({
    ok: false,
    error: 'invalid-request',
  })

  // None of that consumed the attempt: the real approval still works.
  await tab.getByRole('radio', { name: 'Acme' }).check()
  await tab.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(tab.getByTestId('connect-success')).toBeVisible()

  // Replaying the state afterwards finds no attempt and changes nothing.
  expect(await sendExternal(tab, { type: 'connection.complete', state, code: forgedCode })).toEqual(
    { ok: false, error: 'unknown-attempt' },
  )
  await expect(popup.getByTestId('connection-workspace')).toHaveText('Acme')
})

test('cancelling in the dashboard or closing its tab leaves the extension disconnected', async ({
  context,
}) => {
  const account = await createAccount()
  await createWorkspace(account, 'Acme')
  const popup = await openPopupTab(context, DEVELOPMENT_EXTENSION_ID)

  let opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: 'Connect to ContextLayer' }).click()
  let tab = await opened
  await signInIfAsked(tab, account)
  await tab.getByRole('button', { name: 'Cancel' }).click()
  await expect(tab.getByTestId('connect-cancelled')).toBeVisible()
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected')

  opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: 'Connect to ContextLayer' }).click()
  tab = await opened
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'connecting')
  await tab.close()
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected')
})

test('survives a service worker restart, refreshes with rotation and survives an extension reload', async ({
  context,
  extensionBrowser,
  serviceWorker,
}) => {
  const account = await createAccount()
  await createWorkspace(account, 'Acme')
  const { popup } = await connectExtension(context, account, 'Acme')
  const refreshBefore = await credentialFingerprint(serviceWorker, 'local', 'cl.refresh')
  expect(refreshBefore).not.toBeNull()
  // The refresh token is in the restricted local area, the access token in session only.
  expect(await credentialFingerprint(serviceWorker, 'session', 'cl.refresh')).toBeNull()
  expect(await credentialFingerprint(serviceWorker, 'local', 'cl.access')).toBeNull()

  // 1. Worker restart: Chrome stops idle workers; storage.session survives.
  await stopServiceWorker(extensionBrowser, DEVELOPMENT_EXTENSION_ID)
  await popup.reload()
  await expect(popup.getByTestId('connection-workspace')).toHaveText('Acme')
  const worker = await extensionWorker(context)
  expect(await credentialFingerprint(worker, 'local', 'cl.refresh')).toBe(refreshBefore)

  // 2. Refresh: without an access token the worker rotates the refresh token.
  await worker.evaluate(() => chrome.storage.session.remove('cl.access'))
  await popup.reload()
  await expect(popup.getByTestId('connection-workspace')).toHaveText('Acme')
  const refreshAfter = await credentialFingerprint(worker, 'local', 'cl.refresh')
  expect(refreshAfter).not.toBeNull()
  expect(refreshAfter).not.toBe(refreshBefore)

  // 3. Extension reload: storage.session is cleared, the restricted local area is not.
  const reloaded = await reloadExtension(context, worker)
  expect(await credentialFingerprint(reloaded, 'session', 'cl.access')).toBeNull()
  const afterReload = await openPopupTab(context, DEVELOPMENT_EXTENSION_ID)
  await expect(afterReload.getByTestId('connection-workspace')).toHaveText('Acme')
})

test('stays connected after a browser restart', async ({ profile }) => {
  const account = await createAccount()
  await createWorkspace(account, 'Acme')

  const first = await launchBrowser(profile)
  try {
    await connectExtension(first.context, account, 'Acme')
  } finally {
    await first.close()
  }

  // Same profile: storage.session is gone, the refresh token in local is not.
  const second = await launchBrowser(profile)
  try {
    const popup = await openPopupTab(second.context, DEVELOPMENT_EXTENSION_ID)
    await expect(popup.getByTestId('connection-workspace')).toHaveText('Acme')
  } finally {
    await second.close()
  }
})

test('a refresh answer lost after rotation ends the connection: strict reuse detection', async ({
  context,
  serviceWorker,
}) => {
  const account = await createAccount()
  const workspaceId = await createWorkspace(account, 'Acme')
  const { popup } = await connectExtension(context, account, 'Acme')

  // What a crash between the server's rotation and the local save leaves behind:
  // the server rotated, the worker still holds the parent refresh token.
  const status = await serviceWorker.evaluate(async (api) => {
    const { 'cl.refresh': refresh } = await chrome.storage.local.get<{
      'cl.refresh': { token: string }
    }>('cl.refresh')
    const response = await fetch(`${api}/v1/extension/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantType: 'refresh_token', refreshToken: refresh.token }),
    })
    return response.status // the rotated tokens are dropped: the answer is "lost"
  }, E2E_API_URL)
  expect(status).toBe(200)
  await serviceWorker.evaluate(() => chrome.storage.session.remove('cl.access'))

  await popup.reload()
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'ended')
  const list = await connectedBrowsers(context, workspaceId)
  await expect(list.getByTestId('connection-status')).toHaveText('Revoked')
  await expect(list.getByTestId('connection-row')).toContainText('a refresh token was used twice')
})

test('disconnecting revokes the connection on the server', async ({ context }) => {
  const account = await createAccount()
  const workspaceId = await createWorkspace(account, 'Acme')
  const { popup } = await connectExtension(context, account, 'Acme')

  await popup.getByRole('button', { name: 'Disconnect' }).click()

  await expect(popup.getByTestId('connection-notice')).toContainText(
    'ContextLayer revoked this connection',
  )
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected')
  const list = await connectedBrowsers(context, workspaceId)
  await expect(list.getByTestId('connection-row')).toContainText('Disconnected from the extension')
})

test('revoking from the dashboard refuses the next request of the extension', async ({
  context,
}) => {
  const account = await createAccount()
  const workspaceId = await createWorkspace(account, 'Acme')
  const { popup } = await connectExtension(context, account, 'Acme')

  const list = await connectedBrowsers(context, workspaceId)
  await list.getByRole('button', { name: /^Revoke/ }).click()
  await list.getByRole('button', { name: 'Confirm revoke' }).click()
  await expect(list.getByTestId('connection-status')).toHaveText('Revoked')

  await popup.reload()
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'ended')
  await expect(popup.getByTestId('connection-ended')).toBeVisible()
})

test('switching workspace replaces the connection and revokes the previous one', async ({
  context,
}) => {
  const account = await createAccount()
  const acme = await createWorkspace(account, 'Acme')
  await createWorkspace(account, 'Globex')
  const { popup } = await connectExtension(context, account, 'Acme')

  // Already signed in to the dashboard: straight to the workspace choice.
  const opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: 'Switch workspace' }).click()
  const tab = await opened
  await approveInDashboard(tab, account, 'Globex')
  await expect(tab.getByTestId('connect-success')).toContainText('Globex')
  await expect(popup.getByTestId('connection-workspace')).toHaveText('Globex')

  const list = await connectedBrowsers(context, acme)
  const rows = list.getByTestId('connection-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'Acme' })).toContainText('Replaced by a newer connection')
  await expect(rows.filter({ hasText: 'Globex' }).getByTestId('connection-status')).toHaveText(
    'Active',
  )
})
