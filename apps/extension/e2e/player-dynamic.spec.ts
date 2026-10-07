import type { BrowserContext, Page } from '@playwright/test'

import { expect, extensionWorker, openPopupTab, stopServiceWorker, test } from './fixtures'
import {
  clickInPlayer,
  connectedBrowsers,
  contentScriptState,
  focusedInPlayer,
  playerView,
} from './support/flows'
import {
  acme,
  authorAndPublish,
  DEMO,
  demoPage,
  expectAccessibleCard,
  expectHighlighted,
  play,
  storedRun,
  type Workspace,
} from './support/player'
import type { ExtensionBrowser } from './fixtures'

/**
 * The Guide Player on pages that change (Phase 6b, ADR 0019), in real
 * Chromium, on the demo's `flow/` application: a list (`flow/`) and a form
 * (`flow/customers/new`), reached in the app (pushState) or by a link (a new
 * document). The guide is authored in the real Edit Mode and played from the
 * real popup; the tests change the page through the demo's own controls
 * (`flowDemo`), never through ContextLayer.
 */

const FLOW = `${DEMO}flow/`

/** Step 1 on the list, steps 2 and 3 on the form (reached in the app while authoring). */
async function flowGuide(workspace: Workspace, extensionBrowser: ExtensionBrowser, page: Page) {
  await authorAndPublish(workspace, extensionBrowser, page, 'Flow', [
    {
      title: 'Start a new customer',
      instructions: 'Click New customer.',
      click: () => page.getByTestId('new-customer').click(),
    },
    {
      title: 'Type the name',
      instructions: 'Type the customer name.',
      before: async () => {
        await page.evaluate('flowDemo.toForm()')
      },
      click: () => page.locator('#name').click(),
    },
    {
      title: 'Save the customer',
      instructions: 'Click Save customer.',
      click: () => page.getByTestId('save-customer').click(),
    },
  ])
}

/** A workspace, the flow site turned on and the Flow guide published; the page on `path`. */
async function flowSetUp(context: BrowserContext, extensionBrowser: ExtensionBrowser, path = '') {
  const workspace = await acme(context)
  const page = await demoPage(context, extensionBrowser, 'flow/')
  await flowGuide(workspace, extensionBrowser, page)
  await page.goto(`${FLOW}${path}`)
  await expect.poll(async () => (await contentScriptState(page))?.state).toBe('active')
  return { workspace, page }
}

/** The page's targets never received a click from the guide. */
async function expectNoTargetClicked(page: Page) {
  await expect(page.getByTestId('target-clicks')).toHaveText('0')
}

test('waits for a late target, anchors it, and follows a re-render', async ({
  context,
  extensionBrowser,
}) => {
  const { page } = await flowSetUp(context, extensionBrowser, '?late')

  await play(extensionBrowser, page, 'Flow')

  // Not on the page yet: the step waits, unanchored, with a polite hint.
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      cards: 1,
      step: '0',
      state: 'waiting',
      highlight: undefined,
      hint: "Looking for this step's element…",
    })
  await expectAccessibleCard(context, page)

  // It appears 500 ms later: anchored, once.
  await page.evaluate('setTimeout(() => flowDemo.reveal(), 500)')
  await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
  await expectHighlighted(page, page.getByTestId('new-customer'))
  expect(await playerView(page)).toMatchObject({ hosts: 1, cards: 1, outcome: 'resolved' })

  // A re-render puts an equivalent node elsewhere: the highlight follows the new node.
  const oldBox = await page.getByTestId('new-customer').boundingBox()
  await page.evaluate('flowDemo.rerender()')
  const newBox = await page.getByTestId('new-customer').boundingBox()
  expect(newBox?.x).not.toBe(oldBox?.x)
  await expectHighlighted(page, page.getByTestId('new-customer'))
  expect(await playerView(page)).toMatchObject({ cards: 1, state: 'anchored', step: '0' })
  await expectNoTargetClicked(page)
})

test('follows the application’s routes: pushState, back, forward and the hash', async ({
  context,
  extensionBrowser,
}) => {
  const { page } = await flowSetUp(context, extensionBrowser)
  await play(extensionBrowser, page, 'Flow')
  await expect.poll(async () => (await playerView(page)).state).toBe('anchored')

  await clickInPlayer(page, 'Next')
  // Step 2 belongs to the form: it waits for the user to go there.
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      step: '1',
      state: 'off-page',
      hint: 'This step is on another page. Navigate there to continue.',
      highlight: undefined,
    })
  const before = await storedRun(context, page)

  await page.evaluate('flowDemo.toForm()')
  await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
  await expectHighlighted(page, page.locator('#name'))

  await page.evaluate('history.back()')
  await expect.poll(() => playerView(page)).toMatchObject({ step: '1', state: 'off-page' })
  await page.evaluate('history.forward()')
  await expect.poll(() => playerView(page)).toMatchObject({ step: '1', state: 'anchored' })
  await page.evaluate("location.hash = 'details'")
  await expect.poll(() => playerView(page)).toMatchObject({ step: '1', state: 'anchored' })

  // Same document, same run, same step and generation; one card all along.
  const after = await storedRun(context, page)
  expect(after.run).toMatchObject({
    step: 1,
    generation: before.run?.generation,
    documentId: before.run?.documentId,
  })
  expect((await playerView(page)).cards).toBe(1)
  await expectNoTargetClicked(page)
})

test('continues in the new document a link or a reload loads, at the same step', async ({
  context,
  extensionBrowser,
}) => {
  const { page } = await flowSetUp(context, extensionBrowser)
  await play(extensionBrowser, page, 'Flow')
  await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
  await clickInPlayer(page, 'Next')
  await expect.poll(async () => (await playerView(page)).state).toBe('off-page')
  const onList = await storedRun(context, page)

  // A link: a new document of the same application.
  await page.locator('#link-new').click()
  await page.waitForURL('**/flow/customers/new')
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      hosts: 1,
      cards: 1,
      step: '1',
      state: 'anchored',
    })
  await expectHighlighted(page, page.locator('#name'))
  const onForm = await storedRun(context, page)
  expect(onForm.run).toMatchObject({ step: 1, generation: Number(onList.run?.generation) + 1 })
  expect(onForm.run?.documentId).not.toBe(onList.run?.documentId)

  // A reload: the same step again, never step 1, one card.
  await page.reload()
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      hosts: 1,
      cards: 1,
      step: '1',
      state: 'anchored',
    })
  const reloaded = await storedRun(context, page)
  expect(reloaded.run).toMatchObject({ step: 1, generation: Number(onForm.run?.generation) + 1 })

  await clickInPlayer(page, 'Next')
  await expect.poll(() => playerView(page)).toMatchObject({ step: '2', state: 'anchored' })
  await expectHighlighted(page, page.getByTestId('save-customer'))
  await expectNoTargetClicked(page)
})

test.describe('with the back/forward cache on', () => {
  test.use({ bfcache: true })

  test('binds the guide back to a page bfcache restores, with one card', async ({
    context,
    extensionBrowser,
  }) => {
    const { page } = await flowSetUp(context, extensionBrowser)
    await play(extensionBrowser, page, 'Flow')
    await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
    await clickInPlayer(page, 'Next')
    await expect.poll(async () => (await playerView(page)).state).toBe('off-page')
    const pageA = await storedRun(context, page)
    await page.evaluate("window.__restoredFromCache = 'A'")

    await page.locator('#link-new').click()
    await page.waitForURL('**/flow/customers/new')
    await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
    const pageB = await storedRun(context, page)
    expect(pageB.run?.documentId).not.toBe(pageA.run?.documentId)

    // A page restored from bfcache fires no load event: wait for the commit only.
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForURL(FLOW, { waitUntil: 'commit' })
    // The same document came back from the cache (its main-world state survived).
    await expect.poll(() => page.evaluate('window.__restoredFromCache')).toBe('A')
    expect((await contentScriptState(page))?.injections).toBe(1)
    await expect
      .poll(() => playerView(page))
      .toMatchObject({
        hosts: 1,
        cards: 1,
        step: '1',
        state: 'off-page',
      })
    // The run is bound to the restored page again; the page left behind is stale.
    await expect
      .poll(async () => (await storedRun(context, page)).run?.documentId)
      .toBe(pageA.run?.documentId)

    await page.evaluate('flowDemo.toForm()')
    await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
    expect((await playerView(page)).cards).toBe(1)
  })
})

test('anchors a target inside a host modal dialog, never its copy outside', async ({
  context,
  extensionBrowser,
}) => {
  const workspace = await acme(context)
  const page = await demoPage(context, extensionBrowser, 'flow/')
  await authorAndPublish(workspace, extensionBrowser, page, 'Import', [
    {
      title: 'Confirm the import',
      instructions: 'Click Confirm import in the dialog.',
      before: async () => {
        await page.evaluate('flowDemo.openConfirm()')
      },
      click: () => page.locator('#confirm').getByRole('button', { name: 'Confirm import' }).click(),
    },
  ])
  await page.evaluate('flowDemo.closeConfirm()')

  await play(extensionBrowser, page, 'Import')

  // The dialog is closed: the inline copy on the page is never taken for it.
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      state: 'waiting',
      highlight: undefined,
    })

  await page.evaluate('flowDemo.openConfirm()')
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      state: 'anchored',
      hostParent: 'dialog',
      cards: 1,
    })
  await expectHighlighted(
    page,
    page.locator('#confirm').getByRole('button', { name: 'Confirm import' }),
  )
  // The card is on top of the dialog and usable: Finish works from it.
  await clickInPlayer(page, 'Finish')
  await expect.poll(async () => (await storedRun(context, page)).tabs).toEqual([])
  await expect.poll(async () => (await playerView(page)).cards).toBe(0)
  // The application keeps its dialog.
  expect(await page.evaluate("document.getElementById('confirm').open")).toBe(true)
})

test('keeps the step when the worker stops while the page waits', async ({
  context,
  extensionBrowser,
  extensionId,
}) => {
  const { page } = await flowSetUp(context, extensionBrowser, '?late')
  await play(extensionBrowser, page, 'Flow')
  await expect.poll(async () => (await playerView(page)).state).toBe('waiting')

  // Stopped while waiting for the target: the page keeps waiting on its own.
  await stopServiceWorker(extensionBrowser, extensionId)
  await page.evaluate('flowDemo.reveal()')
  await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
  await clickInPlayer(page, 'Next')
  await expect.poll(() => playerView(page)).toMatchObject({ step: '1', state: 'off-page' })

  // Stopped while waiting for navigation.
  await stopServiceWorker(extensionBrowser, extensionId)
  await page.evaluate('flowDemo.toForm()')
  await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
  await clickInPlayer(page, 'Next')
  await expect
    .poll(() => playerView(page))
    .toMatchObject({
      step: '2',
      state: 'anchored',
      cards: 1,
    })
})

test('a tab that waits, navigates or reloads never touches another tab’s guide', async ({
  context,
  extensionBrowser,
}) => {
  const { page: first } = await flowSetUp(context, extensionBrowser, '?late')
  await play(extensionBrowser, first, 'Flow')
  await expect.poll(async () => (await playerView(first)).state).toBe('waiting')

  // The same page in a second tab (the query tells the tabs apart, not the page pattern).
  const second = await context.newPage()
  await second.goto(`${FLOW}?second`)
  await expect.poll(async () => (await contentScriptState(second))?.state).toBe('active')
  await play(extensionBrowser, second, 'Flow')
  await expect.poll(async () => (await playerView(second)).state).toBe('anchored')
  const secondRun = await storedRun(context, second)

  await first.bringToFront()
  await first.evaluate('flowDemo.reveal()')
  await expect.poll(async () => (await playerView(first)).state).toBe('anchored')
  await clickInPlayer(first, 'Next')
  await first.evaluate('flowDemo.toForm()')
  await expect.poll(() => playerView(first)).toMatchObject({ step: '1', state: 'anchored' })
  await first.reload()
  await expect.poll(() => playerView(first)).toMatchObject({ step: '1', state: 'anchored' })

  // The second tab's guide is as it was.
  expect((await storedRun(context, second)).run).toEqual(secondRun.run)
  expect(await playerView(second)).toMatchObject({ step: '0', state: 'anchored', cards: 1 })

  await first.close()
  await expect.poll(async () => (await storedRun(context, second)).tabs).toEqual([secondRun.tabId])
})

test('Disconnect while a step waits removes everything; nothing comes back', async ({
  context,
  extensionBrowser,
  extensionId,
}) => {
  const { page } = await flowSetUp(context, extensionBrowser, '?late')
  await play(extensionBrowser, page, 'Flow')
  await expect.poll(async () => (await playerView(page)).state).toBe('waiting')

  const popup = await openPopupTab(context, extensionId)
  await popup.getByRole('button', { name: 'Disconnect' }).click()
  await expect(popup.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected')
  await expect.poll(async () => (await playerView(page)).hosts).toBe(0)

  // The target the step waited for appears: no observer is left to show anything.
  await page.bringToFront()
  await page.evaluate('flowDemo.reveal()')
  await page.waitForTimeout(500)
  expect((await playerView(page)).hosts).toBe(0)
  expect((await storedRun(context, page)).tabs).toEqual([])
})

test('a revocation found while a step waits ends the guide; nothing comes back', async ({
  context,
  extensionBrowser,
}) => {
  const { workspace, page } = await flowSetUp(context, extensionBrowser, '?late')
  await play(extensionBrowser, page, 'Flow')
  await expect.poll(async () => (await playerView(page)).state).toBe('waiting')
  // Only the player may find the revocation (an open popup would refresh its status).
  for (const other of context.pages()) if (other !== page) await other.close()

  const list = await connectedBrowsers(context, workspace.workspaceId)
  await list.getByRole('button', { name: /^Revoke/ }).click()
  await list.getByRole('button', { name: 'Confirm revoke' }).click()
  await expect(list.getByTestId('connection-status')).toHaveText('Revoked')

  await page.bringToFront()
  await clickInPlayer(page, 'Next')
  await expect.poll(async () => (await playerView(page)).cards).toBe(0)
  await expect.poll(async () => (await storedRun(context, page)).tabs).toEqual([])
  await page.evaluate('flowDemo.reveal()')
  await page.waitForTimeout(500)
  expect((await playerView(page)).cards).toBe(0)
  const worker = await extensionWorker(context)
  expect(
    await worker.evaluate(async () => Object.keys(await chrome.storage.session.get('cl.ended'))),
  ).toEqual(['cl.ended'])
})

test('the shortcut moves the focus to the card, and Escape gives it back', async ({
  context,
  extensionBrowser,
}) => {
  const { page } = await flowSetUp(context, extensionBrowser)
  await play(extensionBrowser, page, 'Flow')
  await expect.poll(async () => (await playerView(page)).state).toBe('anchored')
  await page.bringToFront()
  await page.locator('#go-list').focus()

  // What the focus-guide command does (CDP input cannot press a browser
  // shortcut, ADR 0019): the worker asks the page bound to the tab's run.
  const worker = await extensionWorker(context)
  await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url)
    const runs = (await chrome.storage.session.get('cl.players'))['cl.players'] as Record<
      string,
      { documentId: string }
    >
    const run = tab?.id === undefined ? undefined : runs[String(tab.id)]
    if (tab?.id === undefined || !run) throw new Error('no run')
    await chrome.tabs.sendMessage(tab.id, { type: 'player.focus' }, { documentId: run.documentId })
  }, page.url())

  await expect.poll(() => focusedInPlayer(page)).toBe('title')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await playerView(page)).cards).toBe(0)
  expect(await page.evaluate('document.activeElement?.id')).toBe('go-list')
})
