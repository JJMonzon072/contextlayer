import { expect, test } from './fixtures'

/** Any http://localhost page matches the Phase 1 content script; the body is stubbed. */
const TARGET_URL = 'http://localhost:4321/target-app'

test('loads the Manifest V3 service worker', ({ serviceWorker, extensionId }) => {
  expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`)
})

test('popup shows the API status obtained through the service worker', async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)

  await expect(popup.getByRole('heading', { name: 'ContextLayer' })).toBeVisible()
  await expect(popup.getByTestId('api-status')).toHaveText('Operational')
})

test('popup explains when the active tab has no content script', async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)

  // The active tab is the popup page itself, where content scripts never run.
  await popup.getByRole('button', { name: 'Check this page' }).click()

  await expect(popup.getByTestId('page-status')).toContainText('not running on this page')
})

test.describe('content script', () => {
  test.beforeEach(async ({ context }) => {
    await context.route(TARGET_URL, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Target app</title><h1>Existing web app</h1>',
      }),
    )
  })

  test('mounts its UI root inside a closed shadow root', async ({ context }) => {
    const page = await context.newPage()
    await page.goto(TARGET_URL)

    const host = page.locator('contextlayer-root')
    await expect(host).toHaveAttribute('data-contextlayer-version', /\d+\.\d+\.\d+/)
    // Closed mode: page scripts cannot reach into ContextLayer's UI.
    expect(await host.evaluate((element) => element.shadowRoot)).toBeNull()
  })

  test('answers pings with page details and the API status from the service worker', async ({
    context,
    serviceWorker,
  }) => {
    const page = await context.newPage()
    await page.goto(TARGET_URL)
    await expect(page.locator('contextlayer-root')).toBeAttached()

    const response = await serviceWorker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url })
      if (tab?.id === undefined) throw new Error('target tab not found')
      return chrome.tabs.sendMessage(tab.id, { type: 'page.ping' })
    }, TARGET_URL)

    expect(response).toEqual({
      ok: true,
      data: {
        url: TARGET_URL,
        title: 'Target app',
        extensionVersion: expect.stringMatching(/\d+\.\d+\.\d+/) as unknown,
        api: 'ok',
      },
    })
  })
})
