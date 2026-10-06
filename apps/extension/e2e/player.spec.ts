import AxeBuilder from '@axe-core/playwright'
import { guidesPath, type Guide, type GuideList } from '@contextlayer/shared'
import type { BrowserContext, Locator, Page } from '@playwright/test'

import { GRANTED_SITE, UNGRANTED_SITE } from './environment'
import {
  expect,
  extensionWorker,
  openPopupTab,
  stopServiceWorker,
  test,
  type ExtensionBrowser,
} from './fixtures'
import {
  createAccount,
  createApplication,
  createWorkspace,
  publishDraft,
  publishGuide,
  type Account,
} from './support/api'
import {
  clickInPlayer,
  connectExtension,
  focusedInPlayer,
  openActionPopup,
  openEditMode,
  overlayParts,
  overlayStyles,
  playerCardMarkup,
  playerView,
  sidePanels,
} from './support/flows'

/**
 * The Guide Player in real Chromium (Phase 6a): a guide authored with the
 * real Edit Mode, published through the API, started from the real toolbar
 * popup and played on the demo application. The card lives in a closed
 * shadow root: it is read and clicked through CDP (which page scripts
 * cannot use), with the real mouse and keyboard.
 */

const DEMO = `${GRANTED_SITE}/demo/`

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

async function demoPage(context: BrowserContext, extensionBrowser: ExtensionBrowser, path = '') {
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

/**
 * Authors a guide in the real Edit Mode, one captured element per step,
 * saves it, leaves Edit Mode and publishes it.
 */
async function authorAndPublish(
  workspace: Workspace,
  extensionBrowser: ExtensionBrowser,
  page: Page,
  title: string,
  steps: { title: string; instructions: string; click: () => Promise<void> }[],
): Promise<Guide> {
  const panel = await openEditMode(extensionBrowser, page)
  await panel.getByLabel('New guide').fill(title)
  await panel.getByRole('button', { name: 'Create' }).click()
  await expect(panel.getByRole('heading', { name: title })).toBeVisible()
  for (const step of steps) {
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
async function play(extensionBrowser: ExtensionBrowser, page: Page, title: string) {
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  const closed = popup.waitForEvent('close')
  await popup.getByRole('button', { name: `Play ${title}` }).click()
  await closed
}

async function storedRun(context: BrowserContext) {
  const worker = await extensionWorker(context)
  return worker.evaluate(async () => {
    const run = (await chrome.storage.session.get('cl.player'))['cl.player'] as
      Record<string, unknown> | undefined
    const local = await chrome.storage.local.get('cl.player')
    return { run: run ?? null, local: Object.keys(local) }
  })
}

/** The page's own state: the player never clicks, types or submits for the user. */
async function expectPageUntouched(page: Page) {
  await expect(page).toHaveURL(DEMO)
  await expect(page.getByTestId('page-clicks')).toHaveText('0')
  await expect(page.getByTestId('page-clicks')).not.toHaveAttribute('data-submitted', 'true')
  await expect(page.locator('#customer-name')).toHaveValue('Ana Ejemplo')
}

/** The highlight is drawn around `element` (within a few pixels of its border box). */
async function expectHighlighted(page: Page, element: Locator) {
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

test('authors a guide, publishes it and plays it step by step from the popup', async ({
  context,
  extensionBrowser,
  extensionId,
}) => {
  const workspace = await acme(context)
  const page = await demoPage(context, extensionBrowser)
  const guide = await authorAndPublish(workspace, extensionBrowser, page, 'Create a customer', [
    {
      title: 'Start a new customer',
      instructions: 'Click New customer to open the form.',
      click: () => page.getByTestId('new-customer').click(),
    },
    {
      title: 'Type the name',
      instructions: 'Type the customer name.',
      click: () => page.locator('#customer-name').click(),
    },
    {
      title: 'Save the customer',
      instructions: 'Click Save customer.',
      click: () => page.getByRole('button', { name: 'Save customer' }).click(),
    },
  ])
  await expectPageUntouched(page)

  await play(extensionBrowser, page, 'Create a customer')

  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      hosts: 1,
      cards: 1,
      open: true,
      outcome: 'resolved',
      step: '0',
      hint: undefined,
      buttons: ['Previous', 'Next', 'Close guide'],
    })
  const first = await playerView(page)
  expect(first.text).toContain('Create a customer')
  expect(first.text).toContain('Step 1 of 3')
  expect(first.text).toContain('Click New customer to open the form.')
  await expectHighlighted(page, page.getByTestId('new-customer'))
  // Run state: local to this browser session, bound to the tab and version.
  const { run, local } = await storedRun(context)
  expect(run).toMatchObject({
    origin: GRANTED_SITE,
    guideId: guide.id,
    version: 1,
    step: 0,
    generation: 0,
  })
  expect(local).toEqual([])

  await clickInPlayer(page, 'Next')
  await expect.poll(async () => (await playerView(page)).step).toBe('1')
  await expect.poll(async () => (await playerView(page)).outcome).toBe('resolved')
  await expectHighlighted(page, page.locator('#customer-name'))

  // The worker stops mid-guide: the step is kept, and Next still works once.
  await stopServiceWorker(extensionBrowser, extensionId)
  await clickInPlayer(page, 'Next')
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      hosts: 1,
      cards: 1,
      step: '2',
      outcome: 'resolved',
      buttons: ['Previous', 'Finish', 'Close guide'],
    })
  await expectHighlighted(page, page.getByRole('button', { name: 'Save customer' }))
  expect((await storedRun(context)).run).toMatchObject({ step: 2, generation: 2 })

  await clickInPlayer(page, 'Previous')
  await expect.poll(async () => (await playerView(page)).step).toBe('1')
  await clickInPlayer(page, 'Next')
  await expect.poll(async () => (await playerView(page)).step).toBe('2')

  await clickInPlayer(page, 'Finish')
  await expect.poll(async () => (await playerView(page)).hosts).toBe(0)
  await expect.poll(async () => (await storedRun(context)).run).toBeNull()
  await expectPageUntouched(page)
})

test('never anchors an ambiguous target and shows a missing one on its own', async ({
  context,
  extensionBrowser,
}) => {
  const workspace = await acme(context)
  const page = await demoPage(context, extensionBrowser)
  await authorAndPublish(workspace, extensionBrowser, page, 'Recent customers', [
    {
      title: 'Edit Luis',
      instructions: 'Open the second customer.',
      click: () => page.getByRole('button', { name: 'Edit' }).nth(1).click(),
    },
    {
      title: 'Archive old customers',
      instructions: 'Archive them at the end of the year.',
      click: () => page.getByTestId('archive').click(),
    },
  ])
  // The application changed after the guide was published.
  await page.getByTestId('archive').evaluate((element) => {
    element.remove()
  })

  await play(extensionBrowser, page, 'Recent customers')

  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      open: true,
      step: '0',
      outcome: 'ambiguous',
      highlight: undefined,
      hint: 'More than one element matches this step, so none is highlighted.',
      side: 'none',
    })
  await clickInPlayer(page, 'Next')
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      open: true,
      step: '1',
      outcome: 'not-found',
      highlight: undefined,
      hint: "This step's element isn't on the page right now.",
    })
  await clickInPlayer(page, 'Close guide')
  await expect.poll(async () => (await playerView(page)).hosts).toBe(0)
  await expectPageUntouched(page)
})

test('plays a guide with the keyboard alone, with an accessible card', async ({
  context,
  extensionBrowser,
}) => {
  const workspace = await acme(context)
  await publishGuide(workspace.account, workspace.workspaceId, workspace.applicationId, 'Tour', [
    'Welcome',
    'Where to start',
  ])
  const page = await demoPage(context, extensionBrowser)

  await play(extensionBrowser, page, 'Tour')

  // Nothing on the page had the focus: the card takes it, on its title.
  await expect.poll(() => focusedInPlayer(page)).toBe('title')
  await expect.poll(async () => (await playerView(page)).outcome).toBe('none')
  await page.keyboard.press('Tab')
  expect(await focusedInPlayer(page)).toBe('secondary')
  await page.keyboard.press('Tab')
  expect(await focusedInPlayer(page)).toBe('primary')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await playerView(page)).step).toBe('1')
  // The focus stays on the same button, now Finish.
  expect(await focusedInPlayer(page)).toBe('primary')
  expect((await playerView(page)).buttons).toEqual(['Previous', 'Finish', 'Close guide'])
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await playerView(page)).step).toBe('0')

  // As assistive technology sees it: a dialog named after the step, with named buttons.
  const session = await page.context().newCDPSession(page)
  const { nodes } = (await session.send('Accessibility.getFullAXTree')) as {
    nodes: { role?: { value?: string }; name?: { value?: string }; ignored?: boolean }[]
  }
  await session.detach()
  const named = (role: string) =>
    nodes
      .filter((node) => !node.ignored && node.role?.value === role)
      .map((node) => node.name?.value)
  expect(named('dialog')).toContain('Welcome')
  expect(named('button')).toEqual(expect.arrayContaining(['Previous', 'Next', 'Close guide']))

  // axe on the card's own markup and styles (it cannot enter a closed root).
  const markup = (await playerCardMarkup(page)).replace(/ popover="manual"/g, '')
  const styles = (await overlayStyles(page)).replaceAll('</', '<\\/')
  const copy = await context.newPage()
  await copy.setContent(
    `<!doctype html><html lang="en"><head><title>Player card</title><style>${styles}</style></head><body><main>${markup}</main></body></html>`,
  )
  const { violations } = await new AxeBuilder({ page: copy }).analyze()
  expect(violations).toEqual([])
  await copy.close()

  // Escape inside the card closes the guide.
  await page.bringToFront()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await playerView(page)).hosts).toBe(0)
  await expect.poll(async () => (await storedRun(context)).run).toBeNull()

  // With the focus in a field, the guide never takes it, and Escape stays the page's.
  await page.locator('#customer-name').focus()
  await play(extensionBrowser, page, 'Tour')
  await expect.poll(async () => (await playerView(page)).open).toBe(true)
  await page.bringToFront()
  expect(await page.evaluate('document.activeElement?.id')).toBe('customer-name')
  await page.keyboard.press('Escape')
  expect((await playerView(page)).open).toBe(true)
  await expect(page.locator('#customer-name')).toHaveValue('Ana Ejemplo')
})

test('lists only guides for this page, and never overlaps Edit Mode', async ({
  context,
  extensionBrowser,
}) => {
  const workspace = await acme(context)
  const { account, workspaceId, applicationId } = workspace
  await publishGuide(account, workspaceId, applicationId, 'Here', ['Welcome'], {
    pathname: '/demo/',
  })
  await publishGuide(account, workspaceId, applicationId, 'On reports', ['Reports'], {
    pathname: '/demo/reports.html',
  })
  await publishGuide(account, workspaceId, applicationId, 'Anywhere', ['Anywhere'])
  const page = await demoPage(context, extensionBrowser)

  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('guide')).toHaveCount(2)
  await expect(popup.getByTestId('play')).toHaveCount(2)
  await expect(popup.getByRole('button', { name: 'Play Here' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Play Anywhere' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Play On reports' })).toHaveCount(0)
  await popup.close()

  await play(extensionBrowser, page, 'Here')
  await expect.poll(async () => (await playerView(page)).open).toBe(true)

  // Edit Mode opens on this tab: the guide ends first, its UI goes away.
  const panel = await openEditMode(extensionBrowser, page)
  await expect(panel.getByTestId('guide-chooser')).toBeVisible()
  await expect.poll(async () => (await playerView(page)).cards).toBe(0)
  await expect.poll(async () => (await storedRun(context)).run).toBeNull()

  // While Edit Mode is open, no guide starts on this tab.
  const again = await openActionPopup(extensionBrowser, page)
  await again.getByRole('button', { name: 'Play Here' }).click()
  await expect(again.getByRole('alert')).toHaveText(
    'Edit Mode is open on this tab. Exit it to play a guide.',
  )
  expect((await playerView(page)).cards).toBe(0)
})

test('a reload or Disconnect ends the guide and leaves nothing on the page', async ({
  context,
  extensionBrowser,
  extensionId,
}) => {
  const workspace = await acme(context)
  await publishGuide(workspace.account, workspace.workspaceId, workspace.applicationId, 'Tour', [
    'Welcome',
    'Where to start',
  ])
  const page = await demoPage(context, extensionBrowser)

  await play(extensionBrowser, page, 'Tour')
  await expect.poll(async () => (await playerView(page)).open).toBe(true)
  await page.reload()
  await expect.poll(async () => (await storedRun(context)).run).toBeNull()
  expect((await playerView(page)).hosts).toBe(0)

  await play(extensionBrowser, page, 'Tour')
  await expect.poll(async () => (await playerView(page)).open).toBe(true)
  const popup = await openPopupTab(context, extensionId)
  await popup.getByRole('button', { name: 'Disconnect' }).click()
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected')
  await expect.poll(async () => (await playerView(page)).hosts).toBe(0)
  await expect.poll(async () => (await storedRun(context)).run).toBeNull()
})

test('plays under a strict CSP with Trusted Types, without a single violation', async ({
  context,
  extensionBrowser,
}) => {
  const workspace = await acme(context)
  await context.addInitScript({
    content: `globalThis.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        globalThis.__cspViolations.push(event.violatedDirective + ' ' + event.blockedURI)
      })`,
  })
  const page = await demoPage(context, extensionBrowser, 'strict/')
  await authorAndPublish(workspace, extensionBrowser, page, 'Strict page', [
    {
      title: 'Start a new customer',
      instructions: 'Click New customer.',
      click: () => page.getByTestId('new-customer').click(),
    },
  ])

  await play(extensionBrowser, page, 'Strict page')

  // Highlight and card are drawn and styled although the page allows no inline style.
  await expect.poll(async () => (await playerView(page)).outcome).toBe('resolved')
  await expectHighlighted(page, page.getByTestId('new-customer'))
  const { parts } = await overlayParts(page)
  expect(parts.box?.borderTopWidth).toBe('2px')
  expect(parts.player?.width).toBe('320px')
  expect(await page.evaluate('globalThis.__cspViolations')).toEqual([])
  await clickInPlayer(page, 'Finish')
  await expect.poll(async () => (await playerView(page)).hosts).toBe(0)
  await expect(page.getByTestId('page-clicks')).toHaveText('0')

  // Control: the policy is enforced and the listener reports it.
  await page.evaluate(
    `document.head.append(Object.assign(document.createElement('style'), { textContent: 'p {}' }))`,
  )
  await expect
    .poll(async () => (await page.evaluate<string[]>('globalThis.__cspViolations')).length)
    .toBeGreaterThan(0)
})
