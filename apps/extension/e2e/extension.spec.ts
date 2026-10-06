import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'

import { expect, test } from './fixtures'

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

test('registers no content script before a site is turned on', async ({ serviceWorker }) => {
  expect(
    await serviceWorker.evaluate(() => chrome.scripting.getRegisteredContentScripts()),
  ).toEqual([])
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest())
  expect(manifest.content_scripts).toBeUndefined()
})

test('extension pages trigger no CSP eval violation (zod runs jitless)', async ({
  context,
  extensionId,
}) => {
  // Without `z.config({ jitless: true })` first, this page reported two
  // `script-src eval` violations from zod's `new Function` probe.
  await context.addInitScript({
    content: `globalThis.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        globalThis.__cspViolations.push(event.violatedDirective + ' ' + event.blockedURI)
      })`,
  })
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await expect(popup.getByTestId('api-status')).toHaveText('Operational')

  expect(await popup.evaluate('globalThis.__cspViolations')).toEqual([])
})
