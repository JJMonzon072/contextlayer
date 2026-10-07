import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  chromium,
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test'

import { E2E_OUT_DIR } from './environment'

/**
 * One Chromium per test with the e2e build loaded, in new headless mode (the
 * default headless shell cannot load extensions).
 *
 * - The profile lives in the OS temp directory, never among Playwright's
 *   artifacts: it holds the extension's credentials. It is deleted afterwards.
 * - A remote-debugging port gives tests a browser-level CDP connection, used to
 *   stop the service worker the way Chrome does when it is idle, and to reach
 *   the real action popup.
 */
export interface ExtensionBrowser {
  context: BrowserContext
  /**
   * A new browser-level CDP connection to the same Chromium. A connection only
   * lists the extension popup if the popup existed when it connected, so each
   * use connects again; all of them end with the browser.
   */
  cdp: () => Promise<Browser>
  close: () => Promise<void>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (address === null || typeof address === 'string') throw new Error('no free port')
  return address.port
}

/**
 * Starts Chromium on `profile`; call again with the same profile to "restart
 * the browser". `bfcache`: Playwright launches Chromium with
 * `--disable-back-forward-cache`; the bfcache scenarios launch it without.
 */
export async function launchBrowser(
  profile: string,
  options: { bfcache?: boolean } = {},
): Promise<ExtensionBrowser> {
  const port = await freePort()
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    ...(options.bfcache && { ignoreDefaultArgs: ['--disable-back-forward-cache'] }),
    args: [
      `--disable-extensions-except=${E2E_OUT_DIR}`,
      `--load-extension=${E2E_OUT_DIR}`,
      `--remote-debugging-port=${String(port)}`,
    ],
  })
  const connections: Promise<Browser>[] = []
  const cdp = () => {
    const connection = chromium.connectOverCDP(`http://localhost:${String(port)}`)
    connections.push(connection)
    return connection
  }
  return {
    context,
    cdp,
    close: async () => {
      await context.close()
      for (const connection of connections) {
        await (await connection).close().catch(() => undefined)
      }
    },
  }
}

export async function extensionWorker(context: BrowserContext): Promise<Worker> {
  const [existing] = context
    .serviceWorkers()
    .filter((worker) => worker.url().endsWith('/background.js'))
  return existing ?? (await context.waitForEvent('serviceworker'))
}

/** Stops the service worker like Chrome does when it is idle (Target.closeTarget). */
export async function stopServiceWorker(browser: ExtensionBrowser, extensionId: string) {
  const session = await (await browser.cdp()).newBrowserCDPSession()
  const { targetInfos } = await session.send('Target.getTargets')
  const worker = targetInfos.find(
    (target) =>
      target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`),
  )
  expect(worker, 'the service worker is running').toBeDefined()
  if (worker) await session.send('Target.closeTarget', { targetId: worker.targetId })
  await session.detach()
}

/**
 * Reloads the extension like the chrome://extensions reload button. Chrome only
 * brings an unpacked extension back when Developer mode is on (with it off the
 * extension stays disabled, as the Phase 4 spike showed), and Developer mode is
 * how unpacked extensions are loaded in the first place.
 */
export async function reloadExtension(context: BrowserContext, worker: Worker): Promise<Worker> {
  const settings = await context.newPage()
  await settings.goto(`chrome://extensions/?id=${new URL(worker.url()).host}`)
  const developerMode = settings.locator('#devMode')
  if ((await developerMode.getAttribute('aria-pressed')) !== 'true') await developerMode.click()
  await expect(developerMode).toHaveAttribute('aria-pressed', 'true')
  const next = context.waitForEvent('serviceworker')
  await worker.evaluate(() => {
    setTimeout(() => {
      chrome.runtime.reload()
    }, 50)
  })
  const reloaded = await next
  await settings.close()
  return reloaded
}

/** The extension popup opened as a tab (same page, same messaging as the toolbar popup). */
export async function openPopupTab(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  return popup
}

interface Fixtures {
  /** Launch Chromium with the back/forward cache on (off by default under Playwright). */
  bfcache: boolean
  profile: string
  extensionBrowser: ExtensionBrowser
  context: BrowserContext
  serviceWorker: Worker
  extensionId: string
}

export const test = base.extend<Fixtures>({
  bfcache: [false, { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
  profile: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'contextlayer-e2e-'))
    await use(profile)
    await rm(profile, { recursive: true, force: true })
  },
  extensionBrowser: async ({ profile, bfcache }, use) => {
    const launched = await launchBrowser(profile, { bfcache })
    await use(launched)
    await launched.close()
  },
  context: async ({ extensionBrowser }, use) => {
    await use(extensionBrowser.context)
  },
  serviceWorker: async ({ context }, use) => {
    await use(await extensionWorker(context))
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host)
  },
})

export { expect } from '@playwright/test'
