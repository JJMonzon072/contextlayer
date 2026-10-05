import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'

import { GRANTED_SITE, UNGRANTED_SITE } from './environment'
import { expect, extensionWorker, test, type ExtensionBrowser } from './fixtures'
import { createAccount, createApplication, createWorkspace, type Account } from './support/api'
import { connectExtension, openActionPopup, openEditMode, sidePanels } from './support/flows'

/**
 * Edit Mode in real Chromium (Phase 5): the real side panel, opened from the
 * real toolbar popup with a real click. The panel is reached through a CDP
 * connection; nothing opens `sidepanel.html` as a tab.
 */

interface Workspace {
  account: Account
  workspaceId: string
  applicationId: string
}

async function acme(context: BrowserContext): Promise<Workspace> {
  const account = await createAccount()
  const workspaceId = await createWorkspace(account, 'Acme')
  const applicationId = await createApplication(account, workspaceId, 'Acme CRM', [GRANTED_SITE])
  await createApplication(account, workspaceId, 'Acme Wiki', [UNGRANTED_SITE])
  await connectExtension(context, account, 'Acme')
  return { account, workspaceId, applicationId }
}

async function activeSite(
  context: BrowserContext,
  extensionBrowser: ExtensionBrowser,
  path = '/customers',
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${GRANTED_SITE}${path}`)
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
  await popup.getByRole('button', { name: 'Turn on for this site' }).click()
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  await popup.close()
  return page
}

async function tabIdOf(context: BrowserContext, page: Page): Promise<number | undefined> {
  const worker = await extensionWorker(context)
  return worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url())
}

async function storedSession(context: BrowserContext) {
  const worker = await extensionWorker(context)
  return worker.evaluate(
    async () =>
      ((await chrome.storage.session.get('cl.authoring'))['cl.authoring'] ?? null) as {
        tabId: number
        origin: string
        panelId: string
      } | null,
  )
}

test('opens Edit Mode in a side panel bound to the tab it was opened on', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await activeSite(context, extensionBrowser)

  const panel = await openEditMode(extensionBrowser, page)

  expect(new URL(panel.url()).searchParams.get('tab')).toBe(String(await tabIdOf(context, page)))
  await expect(panel.getByTestId('session')).toContainText('Acme')
  await expect(panel.getByTestId('session')).toContainText(GRANTED_SITE)
  await expect(panel.getByTestId('guide-chooser')).toBeVisible()
  const session = await storedSession(context)
  expect(session).toMatchObject({ tabId: await tabIdOf(context, page), origin: GRANTED_SITE })
  const { violations } = await new AxeBuilder({ page: panel }).setLegacyMode(true).analyze()
  expect(violations).toEqual([])
})

test('Edit Mode is offered only where ContextLayer is on', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await context.newPage()
  await page.goto(`${GRANTED_SITE}/customers`)

  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
  await expect(popup.getByTestId('edit-mode')).toHaveCount(0)
})

test('Exit closes the panel and ends the session; Edit Mode opens again from the popup', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await activeSite(context, extensionBrowser)
  const panel = await openEditMode(extensionBrowser, page)
  const first = await storedSession(context)

  await panel.getByTestId('exit').click()

  await expect.poll(async () => (await sidePanels(extensionBrowser)).length).toBe(0)
  await expect.poll(() => storedSession(context)).toBeNull()

  const again = await openEditMode(extensionBrowser, page)
  await expect(again.getByTestId('guide-chooser')).toBeVisible()
  const second = await storedSession(context)
  expect(second?.panelId).toBeDefined()
  expect(second?.panelId).not.toBe(first?.panelId)
})
