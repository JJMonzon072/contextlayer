import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'
import type { Page, Worker } from '@playwright/test'

import { expect, test } from './fixtures'

/**
 * The Phase 1 content script only runs on the local dashboard origins. The page
 * body is stubbed with `route.fulfill`, so no server is needed on that port.
 */
const TARGET_URL = 'http://localhost:4173/__e2e/target-app'
const HOST_SELECTOR = '[data-contextlayer-root]'

const TARGET_HTML = '<!doctype html><title>Target app</title><h1>Existing web app</h1>'

/** A page that tries to break or spy on injected UI from the main world. */
const HOSTILE_HTML = `<!doctype html><title>Hostile app</title>
<script>
  Element.prototype.attachShadow = function () { throw new Error('blocked by the page') }
  customElements.define('contextlayer-root', class extends HTMLElement {})
</script>
<h1>Hostile web app</h1>`

/** Sends `page.ping` from the service worker to the active tab (retried until the script is ready). */
async function pingActiveTab(page: Page, serviceWorker: Worker): Promise<unknown> {
  await page.bringToFront()
  let response: unknown
  await expect
    .poll(async () => {
      response = await serviceWorker
        .evaluate(async () => {
          // No host permission for the page: address the active tab, like the popup.
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
          if (tab?.id === undefined) throw new Error('target tab not found')
          return chrome.tabs.sendMessage(tab.id, { type: 'page.ping' })
        })
        .catch(() => undefined)
      return response !== undefined
    })
    .toBe(true)
  return response
}

test('loads the Manifest V3 service worker with the stable development id', ({
  serviceWorker,
  extensionId,
}) => {
  expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`)
  // The manifest key pins the id: every clone and CI run installs the same extension.
  expect(extensionId).toBe(DEVELOPMENT_EXTENSION_ID)
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
  test('answers pings with page details and the API status from the service worker', async ({
    context,
    serviceWorker,
  }) => {
    await context.route(TARGET_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: TARGET_HTML }),
    )
    const page = await context.newPage()
    await page.goto(TARGET_URL)

    const response = await pingActiveTab(page, serviceWorker)

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

  test('only mounts its UI while it has something to show, in a closed shadow root', async ({
    context,
    serviceWorker,
  }) => {
    await context.route(TARGET_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: TARGET_HTML }),
    )
    const page = await context.newPage()
    await page.goto(TARGET_URL)
    const host = page.locator(HOST_SELECTOR)

    await pingActiveTab(page, serviceWorker)

    await expect(host).toBeAttached()
    // Closed mode: page scripts cannot reach into ContextLayer's UI.
    expect(await host.evaluate((element) => element.shadowRoot)).toBeNull()
    // Nothing a page could use to fingerprint the extension version.
    expect(await host.evaluate((element) => element.getAttributeNames())).toEqual([
      'data-contextlayer-root',
    ])
    // The host is removed again once the toast is gone.
    await expect(host).toHaveCount(0, { timeout: 6_000 })
  })

  test('keeps working on a page that sabotages attachShadow and custom elements', async ({
    context,
    serviceWorker,
  }) => {
    await context.route(TARGET_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: HOSTILE_HTML }),
    )
    const page = await context.newPage()
    await page.goto(TARGET_URL)

    const response = await pingActiveTab(page, serviceWorker)

    expect(response).toMatchObject({ ok: true, data: { title: 'Hostile app', api: 'ok' } })
    // The isolated world has its own prototypes, so the page's patch does not apply.
    await expect(page.locator(HOST_SELECTOR)).toBeAttached()
    expect(await page.locator(HOST_SELECTOR).evaluate((element) => element.shadowRoot)).toBeNull()
  })
})
