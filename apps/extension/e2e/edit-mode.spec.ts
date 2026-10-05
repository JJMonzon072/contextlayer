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
import { createAccount, createApplication, createWorkspace, type Account } from './support/api'
import {
  connectExtension,
  openActionPopup,
  openEditMode,
  overlayParts,
  sidePanels,
} from './support/flows'

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

// --- The full authoring flow on the demo application -------------------------

const DEMO = `${GRANTED_SITE}/demo/`

async function demoPage(
  context: BrowserContext,
  extensionBrowser: ExtensionBrowser,
  path = '',
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${DEMO}${path}`)
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'available')
  await popup.getByRole('button', { name: 'Turn on for this site' }).click()
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  await popup.close()
  return page
}

async function createGuide(panel: Page, title: string) {
  await panel.getByLabel('New guide').fill(title)
  await panel.getByRole('button', { name: 'Create' }).click()
  await expect(panel.getByRole('heading', { name: title })).toBeVisible()
}

/** Adds a step with a title and returns its card. */
async function addStep(panel: Page, title: string): Promise<Locator> {
  await panel.getByRole('button', { name: 'Add step' }).click()
  const step = panel.getByTestId('step').last()
  await step.getByLabel('Title').fill(title)
  return step
}

/**
 * Selects an element for a step with a real click on the page, then accepts
 * it after review. The page must not react to that click.
 */
async function capture(panel: Page, step: Locator, click: () => Promise<void>) {
  await step.getByRole('button', { name: /^(Select|Reselect) element for step/ }).click()
  await expect(step.getByTestId('target-capturing')).toBeVisible()
  await click()
  await expect(step.getByRole('button', { name: 'Use this element' })).toBeVisible()
}

async function expectPageUntouched(page: Page) {
  await expect(page).toHaveURL(DEMO)
  await expect(page.getByTestId('page-clicks')).toHaveText('0')
  await expect(page.getByTestId('page-clicks')).not.toHaveAttribute('data-submitted', 'true')
}

async function savedGuide(workspace: Workspace, title: string): Promise<Guide> {
  const base = `/api${guidesPath(workspace.workspaceId)}`
  const list = (await (
    await workspace.account.api.get(`${base}?applicationId=${workspace.applicationId}`)
  ).json()) as GuideList
  const summary = list.items.find((item) => item.title === title)
  if (!summary) throw new Error(`no guide ${title}`)
  return (await (await workspace.account.api.get(`${base}/${summary.id}`)).json()) as Guide
}

test('authors a guide with three captured elements and saves it as the dashboard sees it', async ({
  context,
  extensionBrowser,
}) => {
  const workspace = await acme(context)
  const page = await demoPage(context, extensionBrowser)
  const panel = await openEditMode(extensionBrowser, page)
  await createGuide(panel, 'Create a customer')

  const first = await addStep(panel, 'Start a new customer')
  await first.getByLabel('Instructions').fill('Click New customer to open the form.')
  await capture(panel, first, () => page.getByTestId('new-customer').click())
  await expectPageUntouched(page)
  await expect(first.getByTestId('target-label')).toHaveText('Button — New customer')
  const { violations } = await new AxeBuilder({ page: panel }).setLegacyMode(true).analyze()
  expect(violations).toEqual([])
  await first.getByRole('button', { name: 'Use this element' }).click()
  await expect(first.getByTestId('target-strength')).toHaveText('Stable target')

  // The icon inside the submit button: promoted to the button, no submit.
  const second = await addStep(panel, 'Save the customer')
  await capture(panel, second, () => page.locator('#customer-form .icon').click())
  await expectPageUntouched(page)
  await expect(second.getByTestId('target-label')).toHaveText('Button — Save customer')
  await second.getByRole('button', { name: 'Use this element' }).click()

  // A link: not followed.
  const third = await addStep(panel, 'Check the reports')
  await capture(panel, third, () => page.getByRole('link', { name: 'Reports' }).click())
  await expectPageUntouched(page)
  await expect(third.getByTestId('target-label')).toHaveText('Link — Reports')
  await third.getByRole('button', { name: 'Use this element' }).click()

  // Reorder from the keyboard: the link becomes step 2.
  await panel.getByRole('button', { name: 'Move step 3 up' }).focus()
  await panel.keyboard.press('Enter')
  await expect(panel.getByTestId('step').nth(1).getByLabel('Title')).toHaveValue(
    'Check the reports',
  )
  await expect(panel.getByTestId('save-state')).toContainText('kept in this browser session')

  await panel.getByTestId('save').click()
  await expect(panel.getByTestId('save-state')).toContainText('Saved to ContextLayer at')

  // Control: outside a selection the page gets its clicks (the picker let go of them).
  await page.getByTestId('new-customer').click()
  await expect(page.getByTestId('page-clicks')).toHaveText('1')

  const saved = await savedGuide(workspace, 'Create a customer')
  expect(saved.revision).toBe(2)
  expect(saved.steps.map((step) => step.title)).toEqual([
    'Start a new customer',
    'Check the reports',
    'Save the customer',
  ])
  expect(saved.steps.map((step) => step.target?.version)).toEqual([1, 1, 1])
  const [newCustomer, reports, save] = saved.steps.map((step) => step.target)
  expect(newCustomer?.locators[0]).toMatchObject({
    strategy: 'testId',
    attr: 'data-testid',
    value: 'new-customer',
    matchCount: 1,
  })
  expect(reports?.element).toMatchObject({ tag: 'a', role: 'link', accessibleName: 'Reports' })
  expect(save?.capture).toMatchObject({ pickedTag: 'span', promotion: 'interactive-ancestor' })
  expect(save?.element).toMatchObject({ tag: 'button', accessibleName: 'Save customer' })
  expect(saved.steps[0]?.body).toEqual({
    version: 1,
    blocks: [
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'Click New customer to open the form.' }],
      },
    ],
  })
  for (const target of [newCustomer, reports, save]) {
    expect(target?.page.urlPattern).toEqual({
      protocol: 'http',
      hostname: 'localhost',
      port: '4179',
      pathname: '/demo/',
    })
    expect(JSON.stringify(target)).not.toMatch(/ana\.ejemplo|example\.test|Prefers calls/)
  }

  // A reload pauses Edit Mode until the author continues.
  await page.reload()
  await expect(panel.getByTestId('paused')).toBeVisible()
  await panel.getByRole('button', { name: 'Continue on this page' }).click()
  await expect(panel.getByTestId('paused')).toHaveCount(0)

  // Closed and opened again: the saved guide comes back from the server.
  await panel.getByTestId('exit').click()
  await expect.poll(async () => (await sidePanels(extensionBrowser)).length).toBe(0)
  const again = await openEditMode(extensionBrowser, page)
  await again.getByRole('button', { name: /Create a customer/ }).click()
  await expect(again.getByTestId('step')).toHaveCount(3)
  await expect(again.getByTestId('target-label')).toHaveText([
    'Button — New customer',
    'Link — Reports',
    'Button — Save customer',
  ])
  // Loaded from the server: no element on this page yet, so no preview.
  await again.getByRole('button', { name: 'Preview step 1 on the page' }).click()
  await expect(again.getByTestId('preview-note')).toHaveText(
    'Select the element again on this page to preview this step.',
  )
})

test('previews a draft step on the element, as text, without the page reacting', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await demoPage(context, extensionBrowser)
  const panel = await openEditMode(extensionBrowser, page)
  await createGuide(panel, 'Archive customers')
  const step = await addStep(panel, '<b>Archive</b> old customers')
  await step.getByLabel('Instructions').fill('Scroll down.\n\n- Click Archive')
  await capture(panel, step, () => page.getByTestId('archive').click())
  await step.getByRole('button', { name: 'Use this element' }).click()

  await step.getByRole('button', { name: 'Preview step 1 on the page' }).click()

  await expect(step.getByRole('button', { name: 'Hide the preview of step 1' })).toBeVisible()
  await expect
    .poll(async () => (await overlayParts(page)).parts.callout?.text)
    .toBe(
      'Preview · draft step, not published <b>Archive</b> old customers Scroll down. • Click Archive Close preview',
    )
  expect((await overlayParts(page)).parts.box?.display).toBe('block')
  expect(await page.locator('b').count()).toBe(0)
  await expect(page.getByTestId('page-clicks')).toHaveText('0')

  await step.getByRole('button', { name: 'Hide the preview of step 1' }).click()
  await expect.poll(async () => (await overlayParts(page)).hosts).toBe(0)
})

test('warns about a positional-only target, ignores dynamic ids and cancels with Escape', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  const page = await demoPage(context, extensionBrowser)
  const panel = await openEditMode(extensionBrowser, page)
  await createGuide(panel, 'Check the service')

  const light = await addStep(panel, 'Check the second light')
  await capture(panel, light, () => page.locator('.lights div').nth(1).click())
  await expect(light.getByTestId('target-strength')).toHaveText('Weak target')
  await expect(light.getByTestId('target-notes')).toContainText(
    'Only structural selectors are available',
  )

  const exporting = await addStep(panel, 'Export')
  await capture(panel, exporting, () => page.getByRole('button', { name: 'Export' }).click())
  await expect(exporting.getByTestId('target-notes')).toContainText(
    'Dynamic identifiers were ignored',
  )

  // Escape on the page cancels the selection and removes everything we drew.
  await exporting.getByRole('button', { name: 'Select again' }).click()
  await expect(exporting.getByTestId('target-capturing')).toBeVisible()
  await expect.poll(async () => (await overlayParts(page)).parts.banner?.display).toBe('block')
  await page.keyboard.press('Escape')
  await expect(exporting.getByText('Cancelled on the page.')).toBeVisible()
  await expect.poll(async () => (await overlayParts(page)).hosts).toBe(0)
  await expectPageUntouched(page)
})

test('works under a strict CSP with Trusted Types, without a single violation', async ({
  context,
  extensionBrowser,
}) => {
  await acme(context)
  await context.addInitScript({
    content: `globalThis.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        globalThis.__cspViolations.push(event.violatedDirective + ' ' + event.blockedURI)
      })`,
  })
  const page = await demoPage(context, extensionBrowser, 'strict/')
  const panel = await openEditMode(extensionBrowser, page)
  await createGuide(panel, 'Strict page')
  const step = await addStep(panel, 'Start a new customer')
  await step.getByRole('button', { name: 'Select element for step 1' }).click()
  await expect(step.getByTestId('target-capturing')).toBeVisible()

  // The overlay is drawn and styled although the page allows no inline style.
  await page.getByTestId('new-customer').hover()
  await expect.poll(async () => (await overlayParts(page)).parts.box?.display).toBe('block')
  const { parts } = await overlayParts(page)
  expect(parts.box?.borderTopWidth).toBe('2px')
  expect(parts.banner?.text).toContain('Click an element to select it')
  await page.getByTestId('new-customer').click()
  await expect(step.getByRole('button', { name: 'Use this element' })).toBeVisible()

  expect(await page.evaluate('globalThis.__cspViolations')).toEqual([])
  // The page's own script ran under that policy too.
  await expect(page.getByRole('button', { name: 'Export' })).toHaveAttribute('id', /^:r[0-9a-z]+:$/)
  await expect(page.getByTestId('page-clicks')).toHaveText('0')

  // Control: the policy is enforced and the listener reports it.
  await page.evaluate(
    `document.head.append(Object.assign(document.createElement('style'), { textContent: 'p {}' }))`,
  )
  await expect
    .poll(async () => (await page.evaluate<string[]>('globalThis.__cspViolations')).length)
    .toBeGreaterThan(0)
})

test('a page cannot forge, trigger or cancel a capture', async ({ context, extensionBrowser }) => {
  await acme(context)
  const page = await demoPage(context, extensionBrowser)
  const panel = await openEditMode(extensionBrowser, page)
  await createGuide(panel, 'Forged')
  const step = await addStep(panel, 'Start a new customer')
  await step.getByRole('button', { name: 'Select element for step 1' }).click()
  await expect(step.getByTestId('target-capturing')).toBeVisible()

  // The page's own script (no DOM typings in the e2e project, hence a string).
  await page.evaluate(`(() => {
    const forged = {
      type: 'picker.result',
      captureId: 'Zk3_q-9xYt2LmN8pQ4rS',
      outcome: { ok: true, descriptor: { version: 1 } },
    }
    window.postMessage(forged, '*')
    window.postMessage({ ...forged, type: 'picker.cancelled', reason: 'escape' }, '*')
    const button = document.querySelector('[data-testid="new-customer"]')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)

  // Still waiting for the author's own click; nothing reached the panel.
  await expect(step.getByTestId('target-capturing')).toBeVisible()
  await expect(step.getByRole('button', { name: 'Use this element' })).toHaveCount(0)
  const worker = await extensionWorker(context)
  expect(
    await worker.evaluate(
      async () =>
        (
          (await chrome.storage.session.get('cl.authoring'))['cl.authoring'] as {
            capture: { state: string } | null
          }
        ).capture?.state,
    ),
  ).toBe('pending')

  await page.getByTestId('new-customer').click()
  await expect(step.getByRole('button', { name: 'Use this element' })).toBeVisible()
  await expectPageUntouched(page)
})

test('a selection survives the service worker stopping before the click', async ({
  context,
  extensionBrowser,
  extensionId,
}) => {
  await acme(context)
  const page = await demoPage(context, extensionBrowser)
  const panel = await openEditMode(extensionBrowser, page)
  await createGuide(panel, 'Worker restart')
  const step = await addStep(panel, 'Start a new customer')
  await step.getByRole('button', { name: 'Select element for step 1' }).click()
  await expect(step.getByTestId('target-capturing')).toBeVisible()

  await stopServiceWorker(extensionBrowser, extensionId)
  await page.getByTestId('new-customer').click()

  await expect(step.getByRole('button', { name: 'Use this element' })).toBeVisible()
  await expect(step.getByTestId('target-label')).toHaveText('Button — New customer')
  await expectPageUntouched(page)
})

test('Disconnect during a selection ends Edit Mode and leaves nothing on the page', async ({
  context,
  extensionBrowser,
  extensionId,
}) => {
  await acme(context)
  const page = await demoPage(context, extensionBrowser)
  const panel = await openEditMode(extensionBrowser, page)
  await createGuide(panel, 'Disconnect')
  const step = await addStep(panel, 'Start a new customer')
  await step.getByRole('button', { name: 'Select element for step 1' }).click()
  await expect.poll(async () => (await overlayParts(page)).parts.banner?.display).toBe('block')

  const popup = await openPopupTab(context, extensionId)
  await popup.getByRole('button', { name: 'Disconnect' }).click()
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected')

  await expect(panel.getByTestId('ended')).toContainText('ContextLayer was disconnected')
  await expect.poll(async () => (await overlayParts(page)).hosts).toBe(0)
  // The page has its clicks back.
  await page.getByTestId('new-customer').click()
  await expect(page.getByTestId('page-clicks')).toHaveText('1')
  const worker = await extensionWorker(context)
  expect(
    await worker.evaluate(async () =>
      Object.keys(await chrome.storage.session.get(['cl.authoring', 'cl.authoringDraft'])),
    ),
  ).toEqual([])
})
