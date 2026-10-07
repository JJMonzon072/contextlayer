import AxeBuilder from '@axe-core/playwright'
import { guidesPath, type Guide, type GuideList } from '@contextlayer/shared'
import type { BrowserContext, Locator, Page } from '@playwright/test'

import { GRANTED_SITE, UNGRANTED_SITE } from '../environment'
import { expect, extensionWorker, type ExtensionBrowser } from '../fixtures'
import {
  createAccount,
  createApplication,
  createWorkspace,
  publishDraft,
  type Account,
} from './api'
import {
  connectExtension,
  openActionPopup,
  openEditMode,
  overlayStyles,
  playerCardMarkup,
  playerView,
  sidePanels,
} from './flows'

/**
 * Shared steps of the Guide Player scenarios: a workspace with the demo's
 * application, a guide authored in the real Edit Mode and published, Play
 * from the real toolbar popup, and the worker's run state read back.
 */

export const DEMO = `${GRANTED_SITE}/demo/`

export interface Workspace {
  account: Account
  workspaceId: string
  applicationId: string
}

export async function acme(context: BrowserContext): Promise<Workspace> {
  const account = await createAccount()
  const workspaceId = await createWorkspace(account, 'Acme')
  const applicationId = await createApplication(account, workspaceId, 'Acme CRM', [GRANTED_SITE])
  await createApplication(account, workspaceId, 'Acme Wiki', [UNGRANTED_SITE])
  await connectExtension(context, account, 'Acme')
  return { account, workspaceId, applicationId }
}

/** Opens a demo page and turns ContextLayer on for the site from the real popup. */
export async function demoPage(
  context: BrowserContext,
  extensionBrowser: ExtensionBrowser,
  path = '',
) {
  const page = await context.newPage()
  await page.goto(`${DEMO}${path}`)
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
  await popup.getByRole('button', { name: 'Turn on for this site' }).click()
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  await popup.close()
  return page
}

async function addStep(panel: Page, title: string, instructions: string): Promise<Locator> {
  await panel.getByRole('button', { name: 'Add step' }).click()
  const step = panel.getByTestId('step').last()
  await step.getByLabel('Title').fill(title)
  await step.getByLabel('Instructions').fill(instructions)
  return step
}

/** Selects the step's element with a real click, then accepts it. */
async function capture(step: Locator, click: () => Promise<void>) {
  await step.getByRole('button', { name: /^(Select|Reselect) element for step/ }).click()
  await expect(step.getByTestId('target-capturing')).toBeVisible()
  await click()
  await step.getByRole('button', { name: 'Use this element' }).click()
}

export interface AuthoredStep {
  title: string
  instructions: string
  /** Done before this step's element is selected (e.g. the app changes its route). */
  before?: () => Promise<void>
  click: () => Promise<void>
}

/**
 * Authors a guide in the real Edit Mode, one captured element per step,
 * saves it, leaves Edit Mode and publishes it.
 */
export async function authorAndPublish(
  workspace: Workspace,
  extensionBrowser: ExtensionBrowser,
  page: Page,
  title: string,
  steps: AuthoredStep[],
): Promise<Guide> {
  const panel = await openEditMode(extensionBrowser, page)
  await panel.getByLabel('New guide').fill(title)
  await panel.getByRole('button', { name: 'Create' }).click()
  await expect(panel.getByRole('heading', { name: title })).toBeVisible()
  for (const step of steps) {
    await step.before?.()
    await capture(await addStep(panel, step.title, step.instructions), step.click)
  }
  await panel.getByTestId('save').click()
  await expect(panel.getByTestId('save-state')).toContainText('Saved to ContextLayer at')
  await panel.getByTestId('exit').click()
  await expect.poll(async () => (await sidePanels(extensionBrowser)).length).toBe(0)

  const base = `/api${guidesPath(workspace.workspaceId)}`
  const list = (await (
    await workspace.account.api.get(`${base}?applicationId=${workspace.applicationId}`)
  ).json()) as GuideList
  const summary = list.items.find((item) => item.title === title)
  if (!summary) throw new Error(`no guide ${title}`)
  await publishDraft(workspace.account, workspace.workspaceId, summary.id)
  return (await (await workspace.account.api.get(`${base}/${summary.id}`)).json()) as Guide
}

/** Play from the real toolbar popup; the popup closes once the guide is on the page. */
export async function play(extensionBrowser: ExtensionBrowser, page: Page, title: string) {
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  const closed = popup.waitForEvent('close')
  await popup.getByRole('button', { name: `Play ${title}` }).click()
  await closed
}

/** The runs stored by the worker: the run of `page`'s tab, and which tabs have one. */
export async function storedRun(context: BrowserContext, page: Page) {
  const worker = await extensionWorker(context)
  return worker.evaluate(async (url) => {
    const runs = ((await chrome.storage.session.get('cl.players'))['cl.players'] ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
    const local = await chrome.storage.local.get(['cl.players', 'cl.player'])
    return {
      run: tab?.id === undefined ? null : (runs[String(tab.id)] ?? null),
      tabId: tab?.id ?? null,
      tabs: Object.keys(runs).map(Number),
      local: Object.keys(local),
    }
  }, page.url())
}

/** The highlight is drawn around `element` (within a few pixels of its border box). */
export async function expectHighlighted(page: Page, element: Locator) {
  await expect
    .poll(async () => {
      const [view, box] = await Promise.all([playerView(page), element.boundingBox()])
      if (!view.highlight || !box) return false
      return (
        Math.abs(view.highlight.x - box.x) <= 4 &&
        Math.abs(view.highlight.y - box.y) <= 4 &&
        Math.abs(view.highlight.width - box.width) <= 6 &&
        Math.abs(view.highlight.height - box.height) <= 6
      )
    })
    .toBe(true)
}

/**
 * axe on a copy of the card's markup with its live styles: axe cannot enter
 * the closed shadow root, so it audits the same markup and CSS outside it.
 */
export async function expectAccessibleCard(context: BrowserContext, page: Page) {
  const markup = (await playerCardMarkup(page)).replace(/ popover="manual"/g, '')
  const styles = (await overlayStyles(page)).replaceAll('</', '<\\/')
  const copy = await context.newPage()
  await copy.setContent(
    `<!doctype html><html lang="en"><head><title>Player card</title><style>${styles}</style></head><body><main>${markup}</main></body></html>`,
  )
  const { violations } = await new AxeBuilder({ page: copy }).analyze()
  await copy.close()
  await page.bringToFront()
  expect(violations).toEqual([])
}
