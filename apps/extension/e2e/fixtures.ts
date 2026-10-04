import { fileURLToPath } from 'node:url'

import { chromium, test as base, type BrowserContext, type Worker } from '@playwright/test'

const extensionPath = fileURLToPath(new URL('../dist', import.meta.url))

interface ExtensionFixtures {
  context: BrowserContext
  serviceWorker: Worker
  extensionId: string
}

/**
 * Chromium only loads unpacked extensions in a persistent context. The
 * `chromium` channel runs the full browser in new headless mode, which supports
 * extensions (the default headless shell does not).
 */
export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    await use(context)
    await context.close()
  },
  serviceWorker: async ({ context }, use) => {
    const [existing] = context.serviceWorkers()
    await use(existing ?? (await context.waitForEvent('serviceworker')))
  },
  extensionId: async ({ serviceWorker }, use) => {
    const id = new URL(serviceWorker.url()).host
    await use(id)
  },
})

export { expect } from '@playwright/test'
