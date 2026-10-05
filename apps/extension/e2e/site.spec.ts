import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'

import { GRANTED_SITE, UNGRANTED_SITE } from './environment'
import {
  expect,
  extensionWorker,
  launchBrowser,
  reloadExtension,
  stopServiceWorker,
  test,
  type ExtensionBrowser,
} from './fixtures'
import {
  createAccount,
  createApplication,
  createWorkspace,
  publishGuide,
  type Account,
} from './support/api'
import {
  connectExtension,
  contentScriptState,
  contentScriptStates,
  evaluateInContentScript,
  openActionPopup,
} from './support/flows'

/**
 * Per-application site access in real Chromium (ADR 0017). GRANTED_SITE is
 * pre-granted by the e2e build, so the popup's real `permissions.request`
 * resolves without Chrome's prompt, which automation cannot answer; the prompt
 * itself is a manual check. Content-script state is read from its isolated
 * world through CDP; nothing in the product exposes it to tests.
 */

const OVERLAY_HOST = '[data-contextlayer-root]'

/**
 * axe in its default mode finishes in a new blank page, which takes the focus
 * and closes the toolbar popup; legacy mode runs entirely inside the popup.
 */
async function expectAccessiblePopup(popup: Page) {
  const { violations } = await new AxeBuilder({ page: popup }).setLegacyMode(true).analyze()
  expect(violations).toEqual([])
}

interface Workspace {
  account: Account
  workspaceId: string
  applicationId: string
}

/** Acme, with GRANTED_SITE and UNGRANTED_SITE registered, one published and one draft guide. */
async function acme(context: BrowserContext): Promise<Workspace> {
  const account = await createAccount()
  const workspaceId = await createWorkspace(account, 'Acme')
  await createWorkspace(account, 'Globex')
  const applicationId = await createApplication(account, workspaceId, 'Acme CRM', [GRANTED_SITE])
  await createApplication(account, workspaceId, 'Acme Wiki', [UNGRANTED_SITE])
  await publishGuide(account, workspaceId, applicationId, 'Create a customer', [
    'Open Customers',
    'Click New customer',
  ])
  await account.api.post(`/api/v1/workspaces/${workspaceId}/guides`, {
    data: { applicationId, title: 'Draft only' },
  })
  await connectExtension(context, account, 'Acme')
  return { account, workspaceId, applicationId }
}

async function openSite(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${GRANTED_SITE}${path}`)
  return page
}

async function turnOn(extensionBrowser: ExtensionBrowser, page: Page): Promise<Page> {
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
  await popup.getByRole('button', { name: 'Turn on for this site' }).click()
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  return popup
}

const expectState = (page: Page, state: string | null) =>
  expect
    .poll(async () => (await contentScriptState(page))?.state ?? null, { timeout: 10_000 })
    .toBe(state)

test('turns ContextLayer on for a registered site and lists its published guides', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  // The popup lists the connection's applications (here as a tab: it needs no active site).
  const tab = await popupTab(context)
  const applications = tab.getByTestId('application')
  await expect(applications).toHaveCount(2)
  await expect(applications.filter({ hasText: 'Acme CRM' })).toContainText(GRANTED_SITE)
  await expect(applications.filter({ hasText: 'Acme Wiki' })).toContainText(UNGRANTED_SITE)
  await expect(tab.getByTestId('application-origin-state')).toHaveText(['Off', 'Off'])
  await tab.close()

  // Open before the site is enabled: the script must be injected into it.
  const open = await openSite(context, '/customers')
  const framed = await openSite(context, '/frame')
  const other = await context.newPage()
  await other.goto(UNGRANTED_SITE)
  expect(await contentScriptState(open)).toBeNull()

  const popup = await openActionPopup(extensionBrowser, open)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
  await expect(popup.getByTestId('site')).toContainText('Acme CRM')
  await expectAccessiblePopup(popup)
  await popup.getByRole('button', { name: 'Turn on for this site' }).click()

  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  const guides = popup.getByTestId('guide')
  await expect(guides).toHaveCount(1)
  await expect(guides).toContainText('Create a customer')
  await expect(guides).toContainText('2 steps')
  // No play button in Phase 4.
  await expect(popup.getByRole('button', { name: /play|start/i })).toHaveCount(0)
  await expectAccessiblePopup(popup)

  // Injected into the tabs that were already open, top frames only.
  await expectState(open, 'active')
  await expectState(framed, 'active')
  expect(await contentScriptStates(framed, { frame: 'child' })).toEqual([])
  // Registered for future navigations on that exact origin, nowhere else.
  const later = await openSite(context, '/deals')
  await expectState(later, 'active')
  expect(await contentScriptState(other)).toBeNull()
  await other.reload()
  expect(await contentScriptState(other)).toBeNull()

  const after = await popupTab(context)
  const state = (name: string) =>
    after
      .getByTestId('application')
      .filter({ hasText: name })
      .getByTestId('application-origin-state')
  await expect(state('Acme CRM')).toHaveText('On')
  await expect(state('Acme Wiki')).toHaveText('Off')
})

test('a second injection is a no-op and the on-page UI stays isolated', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await openSite(context, '/customers')
  const popup = await turnOn(extensionBrowser, page)
  await expectState(page, 'active')

  const worker = await extensionWorker(context)
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url })
    if (tab?.id === undefined) throw new Error('tab not found')
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
  }, page.url())

  await expect.poll(async () => (await contentScriptState(page))?.injections).toBe(2)
  expect(await contentScriptStates(page)).toEqual([{ state: 'active', injections: 2 }])

  // "Check this page": the script answers and shows a toast in a closed shadow root.
  await popup.getByRole('button', { name: 'Check this page' }).click()
  await expect(popup.getByTestId('site-notice')).toHaveText('Running on this page.')
  const host = page.locator(OVERLAY_HOST)
  await expect(host).toHaveCount(1)
  expect(await host.evaluate((element) => element.shadowRoot)).toBeNull()
  expect(await host.evaluate((element) => element.getAttributeNames())).toEqual([
    'data-contextlayer-root',
  ])
  await expect(host).toHaveCount(0, { timeout: 6_000 })
})

test('keeps working on a page that sabotages attachShadow and custom elements', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  await context.route(`${GRANTED_SITE}/hostile`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Hostile app</title><script>
        Element.prototype.attachShadow = function () { throw new Error('blocked by the page') }
        customElements.define('contextlayer-root', class extends HTMLElement {})
        window.__contextlayerContent = { state: 'active', injections: 99 }
      </script><h1>Hostile web app</h1>`,
    }),
  )
  const page = await openSite(context, '/hostile')
  const popup = await turnOn(extensionBrowser, page)

  // The isolated world has its own globals and prototypes: the page's patch and
  // its fake guard do not apply.
  await expectState(page, 'active')
  await popup.getByRole('button', { name: 'Check this page' }).click()
  await expect(page.locator(OVERLAY_HOST)).toBeAttached()
  expect(await page.locator(OVERLAY_HOST).evaluate((element) => element.shadowRoot)).toBeNull()
})

test('content scripts can neither run privileged commands nor read credentials', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await openSite(context, '/customers')
  const popup = await turnOn(extensionBrowser, page)
  await expectState(page, 'active')

  for (const message of [
    { type: 'connection.disconnect' },
    { type: 'connection.start' },
    { type: 'connection.status' },
    { type: 'site.disable', tabId: 1 },
    { type: 'site.status', tabId: 1 },
    { type: 'api.health.get' },
  ]) {
    expect(
      await evaluateInContentScript(page, `chrome.runtime.sendMessage(${JSON.stringify(message)})`),
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  }
  for (const area of ['local', 'session']) {
    expect(
      await evaluateInContentScript(
        page,
        `chrome.storage.${area}.get(null).then(() => 'readable', (error) => String(error))`,
      ),
    ).toContain('Access to storage is not allowed from this context')
  }
  // Its own question only says whether to run.
  expect(
    await evaluateInContentScript(page, `chrome.runtime.sendMessage({ type: 'page.hello' })`),
  ).toEqual({ ok: true, data: { active: true } })

  // Nothing changed.
  await popup.reload()
  await expect(popup.getByTestId('connection-workspace')).toHaveText('Acme')
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
})

test('turning a site off stops its scripts at once', async ({ context, extensionBrowser }) => {
  await acme(context)
  const page = await openSite(context, '/customers')
  const popup = await turnOn(extensionBrowser, page)
  await expectState(page, 'active')

  await popup.getByRole('button', { name: 'Turn off for this site' }).click()

  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
  await expectState(page, 'stopped')
  const later = await openSite(context, '/deals')
  expect(await contentScriptState(later)).toBeNull()
})

test('withdrawing site access in chrome://extensions pauses ContextLayer until it is given back', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await openSite(context, '/customers')
  await turnOn(extensionBrowser, page)
  await expectState(page, 'active')

  const settings = await context.newPage()
  await settings.goto(
    `chrome://extensions/?id=${new URL((await extensionWorker(context)).url()).host}`,
  )
  const siteAccess = settings.locator(
    '#hostAccessToggle:visible, #allHostsToggle:visible, cr-toggle[aria-label*="Automatically allow"]:visible',
  )
  await siteAccess.first().click()

  // Chrome withdrew every host permission, the API's included: the script stops
  // and the popup says why instead of claiming the connection is gone.
  await expectState(page, 'stopped')
  const tab = await popupTab(context)
  await expect(tab.getByTestId('connection-withheld')).toBeVisible()

  await settings.bringToFront()
  await siteAccess.first().click()
  await page.reload()
  await expectState(page, 'active')
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
})

test('turning a site on completes even if the popup closes right after the click', async ({
  context,
  extensionBrowser,
}) => {
  // GRANTED_SITE is pre-granted, so Chrome answers at once and shows no prompt:
  // this shows that the worker, not the popup, completes the request. It is not
  // a test of Chrome's own prompt (manual check in ADR 0017).
  await acme(context)
  const page = await openSite(context, '/customers')
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')

  await popup.getByRole('button', { name: 'Turn on for this site' }).click()
  await popup.close()

  await expectState(page, 'active')
  const again = await openActionPopup(extensionBrowser, page)
  await expect(again.getByTestId('site')).toHaveAttribute('data-state', 'active')
})

test('access granted in chrome://extensions turns no site on by itself', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await openSite(context, '/customers')
  const worker = await extensionWorker(context)
  const settings = await context.newPage()
  await settings.goto(`chrome://extensions/?id=${new URL(worker.url()).host}`)
  const siteAccess = settings.locator(
    '#hostAccessToggle:visible, #allHostsToggle:visible, cr-toggle[aria-label*="Automatically allow"]:visible',
  )
  const granted = () =>
    worker.evaluate(
      (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] }),
      GRANTED_SITE,
    )

  // Real permission events: onRemoved, then onAdded for the site.
  await siteAccess.first().click()
  await expect.poll(granted).toBe(false)
  await siteAccess.first().click()
  await expect.poll(granted).toBe(true)

  await page.reload()
  expect(await contentScriptState(page)).toBeNull()
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([])
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
})

test("platform check: Chrome needs the click's activation, and a message sent first keeps it", async ({
  context,
}) => {
  // Measures the assumption SiteCard.enable() relies on, in this Chromium.
  // User activation is simulated with CDP (`userGesture`), not a real click,
  // and the prompt Chrome opens for UNGRANTED_SITE is never answered.
  const worker = await extensionWorker(context)
  const page = await context.newPage()
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`)
  const session = await context.newCDPSession(page)
  const run = async (expression: string, userGesture: boolean) => {
    const { result } = await session.send('Runtime.evaluate', {
      expression,
      userGesture,
      awaitPromise: true,
      returnByValue: true,
    })
    return result.value as unknown
  }
  const request = `Promise.race([
    chrome.permissions.request({ origins: ['${UNGRANTED_SITE}/*'] }).then(String, (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve('prompt shown'), 1500)),
  ])`

  // Without activation Chrome refuses to ask.
  expect(await run(request, false)).toContain('must be called during a user gesture')
  // With activation, sending the worker message first (not awaited) and asking
  // in the same task still reaches Chrome's prompt.
  expect(
    await run(
      `(() => { void chrome.runtime.sendMessage({ type: 'site.requestActivation', tabId: 0 }); return ${request} })()`,
      true,
    ),
  ).toBe('prompt shown')
})

test('switching workspace removes the sites of the previous one', async ({
  context,
  extensionBrowser,
}) => {
  const { account } = await acme(context)
  const page = await openSite(context, '/customers')
  await turnOn(extensionBrowser, page)
  await expectState(page, 'active')

  await connectExtension(context, account, 'Globex', await popupTab(context))

  await expectState(page, 'stopped')
  const worker = await extensionWorker(context)
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([])
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'not-registered')
})

test('an application whose origin changed is noticed when the popup opens', async ({
  context,
  extensionBrowser,
}) => {
  const { account, workspaceId, applicationId } = await acme(context)
  const page = await openSite(context, '/customers')
  await turnOn(extensionBrowser, page)
  await expectState(page, 'active')

  const response = await account.api.patch(
    `/api/v1/workspaces/${workspaceId}/applications/${applicationId}`,
    { data: { origins: ['https://crm.acme.test'] } },
  )
  expect(response.ok()).toBe(true)

  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'not-registered')
  await expectState(page, 'stopped')
})

test('enabled sites survive a worker restart and a browser restart', async ({ profile }) => {
  const first = await launchBrowser(profile)
  try {
    await acme(first.context)
    const page = await openSite(first.context, '/customers')
    await turnOn(first, page)
    await expectState(page, 'active')

    // Worker restart: the registration persists and a new page wakes the worker.
    const worker = await extensionWorker(first.context)
    await stopServiceWorker(first, new URL(worker.url()).host)
    const later = await openSite(first.context, '/deals')
    await expectState(later, 'active')
  } finally {
    await first.close()
  }

  const second = await launchBrowser(profile)
  try {
    await extensionWorker(second.context)
    const page = await openSite(second.context, '/customers')
    await expectState(page, 'active')
  } finally {
    await second.close()
  }
})

test('after an extension reload the orphaned script steps aside', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await openSite(context, '/customers')
  await turnOn(extensionBrowser, page)
  await expectState(page, 'active')

  await reloadExtension(context, await extensionWorker(context))

  // A new copy runs in a new isolated world; the old one is orphaned.
  const states = async () =>
    (await contentScriptStates(page)).map((state) => state?.state ?? 'none').sort()
  await expect.poll(states).toEqual(['active', 'active'])
  // The orphan notices as soon as the page is shown again, and stops.
  await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
  await expect.poll(states).toEqual(['active', 'stopped'])
})

async function popupTab(context: BrowserContext): Promise<Page> {
  const worker = await extensionWorker(context)
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`)
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'connected')
  return popup
}
