import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'
import {
  expect,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from '@playwright/test'

import { E2E_DASHBOARD_URL } from '../environment'
import { extensionWorker, openPopupTab, type ExtensionBrowser } from '../fixtures'
import { PASSWORD, type Account } from './api'

/**
 * "Connect to ContextLayer" from the popup, through the real dashboard: sign in
 * when asked, choose the workspace, approve, and wait for the dashboard to
 * report what the extension confirmed.
 */
export async function connectExtension(
  context: BrowserContext,
  account: Account,
  workspaceName: string,
  popup?: Page,
): Promise<{ popup: Page; tab: Page }> {
  popup ??= await openPopupTab(context, DEVELOPMENT_EXTENSION_ID)
  const opened = context.waitForEvent('page')
  await popup.getByRole('button', { name: /^(Connect to ContextLayer|Switch workspace)$/ }).click()
  const tab = await opened
  await approveInDashboard(tab, account, workspaceName)
  await expect(tab.getByTestId('connect-success')).toContainText(workspaceName)
  await expect(popup.getByTestId('connection-workspace')).toHaveText(workspaceName)
  return { popup, tab }
}

/** Signs in if the dashboard asks for it and waits for the connect page. */
export async function signInIfAsked(tab: Page, account: Account): Promise<void> {
  const heading = tab.getByRole('heading', { level: 1, name: /^(Sign in|Connect the extension)$/ })
  await expect(heading).toBeVisible()
  if ((await heading.textContent()) === 'Sign in') {
    await tab.getByLabel('Email').fill(account.email)
    await tab.getByLabel('Password').fill(PASSWORD)
    await tab.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(tab.getByRole('heading', { name: 'Connect the extension' })).toBeVisible()
  expect(new URL(tab.url()).pathname).toBe('/extension/connect')
}

export async function approveInDashboard(
  tab: Page,
  account: Account,
  workspaceName: string,
): Promise<void> {
  await signInIfAsked(tab, account)
  await tab.getByRole('radio', { name: workspaceName }).check()
  await tab.getByRole('button', { name: 'Connect', exact: true }).click()
}

/** Sends a message to the extension from a page, as the dashboard does. */
export function sendExternal(target: Page | ReturnType<Page['mainFrame']>, message: unknown) {
  return target.evaluate(
    ([id, payload]) => chrome.runtime.sendMessage<unknown, unknown>(id, payload),
    [DEVELOPMENT_EXTENSION_ID, message] as const,
  )
}

export async function connectedBrowsers(
  context: BrowserContext,
  workspaceId: string,
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${E2E_DASHBOARD_URL}/workspaces/${workspaceId}/connected-browsers`)
  await expect(page.getByRole('heading', { name: 'Connected browsers' })).toBeVisible()
  return page
}

/**
 * A short SHA-256 fingerprint of a stored credential, computed in the worker:
 * tests compare credentials without the values ever leaving the browser.
 */
export function credentialFingerprint(
  worker: Worker,
  area: 'local' | 'session',
  key: 'cl.refresh' | 'cl.access',
): Promise<string | null> {
  return worker.evaluate(
    async ([storageArea, storageKey]) => {
      const record = (await chrome.storage[storageArea].get(storageKey))[storageKey] as
        { token?: string } | undefined
      if (typeof record?.token !== 'string') return null
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.token))
      return [...new Uint8Array(digest).slice(0, 6)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    },
    [area, key] as const,
  )
}

/**
 * Opens the real toolbar popup (`chrome.action.openPopup`) over `page`, which
 * becomes the active tab of its window. The popup is reached through the
 * browser-level CDP connection: Playwright does not list it as a page.
 * Unlike a click on the toolbar icon, this grants no activeTab, so the popup
 * only sees the address of sites the extension already has access to.
 */
export async function openActionPopup(
  extensionBrowser: ExtensionBrowser,
  page: Page,
): Promise<Page> {
  await page.bringToFront()
  const worker = await extensionWorker(page.context())
  const url = page.url()
  await expect
    .poll(() =>
      worker.evaluate(
        async (target) => (await chrome.tabs.query({ url: target, active: true })).length,
        url,
      ),
    )
    .toBe(1)
  // Chrome refuses to open a second popup while one is open.
  for (const open of await toolbarPopups(extensionBrowser)) await open.close()
  await worker.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target, active: true })
    await chrome.action.openPopup({ windowId: tab?.windowId })
  }, url)
  let popup: Page | undefined
  await expect
    .poll(async () => {
      ;[popup] = await toolbarPopups(extensionBrowser)
      return popup !== undefined
    })
    .toBe(true)
  if (!popup) throw new Error('popup not found')
  await popup.waitForLoadState()
  return popup
}

/** popup.html may also be open in a tab; only the toolbar popup has no tab. */
async function toolbarPopups(extensionBrowser: ExtensionBrowser): Promise<Page[]> {
  const browser = await extensionBrowser.cdp()
  const popups: Page[] = []
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    if (
      candidate.url().endsWith('/popup.html') &&
      (await candidate.evaluate(async () => (await chrome.tabs.getCurrent()) === undefined))
    ) {
      popups.push(candidate)
    }
  }
  return popups
}

export interface ContentScriptState {
  state: 'starting' | 'active' | 'inactive' | 'stopped'
  injections: number
}

/**
 * Reads the content script's own state from its isolated world, through CDP:
 * the page's scripts cannot see it. `null` when the script never ran in that
 * frame. `frame: 'child'` looks at the first subframe instead of the top one.
 */
export async function contentScriptStates(
  page: Page,
  options: { frame?: 'top' | 'child' } = {},
): Promise<(ContentScriptState | null)[]> {
  const session = await page.context().newCDPSession(page)
  try {
    const worlds: { id: number; name: string; auxData?: { frameId?: string; type?: string } }[] = []
    session.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context))
    await session.send('Runtime.enable')
    const { frameTree } = await session.send('Page.getFrameTree')
    const frameId =
      options.frame === 'child' ? frameTree.childFrames?.[0]?.frame.id : frameTree.frame.id
    const ours = worlds.filter(
      (world) =>
        world.name === 'ContextLayer' &&
        world.auxData?.type === 'isolated' &&
        world.auxData.frameId === frameId,
    )
    const states: (ContentScriptState | null)[] = []
    for (const world of ours) {
      const { result } = await session.send('Runtime.evaluate', {
        contextId: world.id,
        expression: 'JSON.stringify(globalThis.__contextlayerContent ?? null)',
        returnByValue: true,
      })
      states.push(JSON.parse(String(result.value)) as ContentScriptState | null)
    }
    return states
  } finally {
    await session.detach()
  }
}

/** The single live content script of the top frame, or null when none ever ran. */
export async function contentScriptState(page: Page): Promise<ContentScriptState | null> {
  const states = await contentScriptStates(page)
  return states.at(-1) ?? null
}

/** Runs an expression inside the content script's isolated world (as the script could). */
export async function evaluateInContentScript(page: Page, expression: string): Promise<unknown> {
  const session = await page.context().newCDPSession(page)
  try {
    const worlds: { id: number; name: string; auxData?: { frameId?: string } }[] = []
    session.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context))
    await session.send('Runtime.enable')
    const { frameTree } = await session.send('Page.getFrameTree')
    const world = worlds.findLast(
      (candidate) =>
        candidate.name === 'ContextLayer' && candidate.auxData?.frameId === frameTree.frame.id,
    )
    if (!world) throw new Error('no ContextLayer content script in this page')
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      contextId: world.id,
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'failed')
    return result.value
  } finally {
    await session.detach()
  }
}

/** Edit Mode side panels currently open (reached through a fresh CDP connection). */
export async function sidePanels(extensionBrowser: ExtensionBrowser): Promise<Page[]> {
  const browser = await extensionBrowser.cdp()
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((candidate) => new URL(candidate.url()).pathname === '/sidepanel.html')
}

/**
 * Opens Edit Mode the way an author does: the real toolbar popup over `page`,
 * then a real click on "Edit Mode", whose user gesture `sidePanel.open()`
 * needs. Returns the side panel's page.
 */
export async function openEditMode(extensionBrowser: ExtensionBrowser, page: Page): Promise<Page> {
  const popup = await openActionPopup(extensionBrowser, page)
  await expect(popup.getByTestId('site')).toHaveAttribute('data-state', 'active')
  await popup.getByTestId('edit-mode').click()
  let panel: Page | undefined
  await expect
    .poll(async () => {
      ;[panel] = await sidePanels(extensionBrowser)
      return panel !== undefined
    })
    .toBe(true)
  if (!panel) throw new Error('side panel not found')
  await panel.waitForLoadState()
  return panel
}

interface DomNode {
  nodeId: number
  nodeType: number
  localName: string
  nodeValue: string
  attributes?: string[]
  children?: DomNode[]
  shadowRoots?: DomNode[]
}

export interface OverlayPart {
  /** Computed `display`: `none` while the popover is hidden. */
  display: string
  borderTopWidth: string
  width: string
  text: string
}

/**
 * ContextLayer's on-page UI as Chrome renders it, read through CDP (which can
 * pierce closed shadow roots; page scripts cannot). Tests use it to check that
 * the overlay is drawn, styled under a strict CSP, and removed.
 */
export async function overlayParts(
  page: Page,
): Promise<{ hosts: number; parts: Record<string, OverlayPart> }> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable')
    await session.send('CSS.enable')
    const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode
    }
    const all: DomNode[] = []
    const walk = (node: DomNode) => {
      all.push(node)
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child)
    }
    walk(root)
    const attribute = (node: DomNode, name: string) => {
      const index = node.attributes?.findIndex((value, at) => at % 2 === 0 && value === name)
      return index === undefined || index < 0 ? undefined : node.attributes?.[index + 1]
    }
    const hosts = all.filter((node) => attribute(node, 'data-contextlayer-root') !== undefined)
    const parts: Record<string, OverlayPart> = {}
    const host = hosts.at(-1)
    for (const element of host?.shadowRoots?.[0]?.children ?? []) {
      const className = attribute(element, 'class')
      if (!className) continue
      const { computedStyle } = (await session.send('CSS.getComputedStyleForNode', {
        nodeId: element.nodeId,
      })) as { computedStyle: { name: string; value: string }[] }
      const style = (name: string) =>
        computedStyle.find((entry) => entry.name === name)?.value ?? ''
      const texts: string[] = []
      const collect = (node: DomNode) => {
        if (node.nodeType === 3) texts.push(node.nodeValue)
        for (const child of node.children ?? []) collect(child)
      }
      collect(element)
      parts[className] = {
        display: style('display'),
        borderTopWidth: style('border-top-width'),
        width: style('width'),
        text: texts.join(' ').replace(/\s+/g, ' ').trim(),
      }
    }
    return { hosts: hosts.length, parts }
  } finally {
    await session.detach()
  }
}

/** The Guide Player as Chrome renders it (closed shadow root, read through CDP). */
export interface PlayerView {
  /** ContextLayer hosts in the page, and player cards in them: never more than one. */
  hosts: number
  cards: number
  open: boolean
  outcome: string | undefined
  step: string | undefined
  side: string | undefined
  occluded: boolean
  text: string
  /** The hint shown on the card, if any. */
  hint: string | undefined
  /** Button names: their aria-label, else their text. */
  buttons: string[]
  /** The highlight box, while it is drawn. */
  highlight: { x: number; y: number; width: number; height: number } | undefined
}

interface PlayerNodes {
  hosts: DomNode[]
  card: DomNode | undefined
  box: DomNode | undefined
  buttons: { name: string; node: DomNode }[]
}

function attributeOf(node: DomNode, name: string): string | undefined {
  const index = node.attributes?.findIndex((value, at) => at % 2 === 0 && value === name)
  return index === undefined || index < 0 ? undefined : node.attributes?.[index + 1]
}

function textOf(node: DomNode): string {
  const texts: string[] = []
  const collect = (current: DomNode) => {
    if (current.nodeType === 3) texts.push(current.nodeValue)
    for (const child of current.children ?? []) collect(child)
  }
  collect(node)
  return texts.join(' ').replace(/\s+/g, ' ').trim()
}

async function playerNodes(session: CDPSession): Promise<PlayerNodes> {
  const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as {
    root: DomNode
  }
  const all: DomNode[] = []
  const walk = (node: DomNode) => {
    all.push(node)
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child)
  }
  walk(root)
  const hosts = all.filter((node) => attributeOf(node, 'data-contextlayer-root') !== undefined)
  const parts = hosts.flatMap((host) => host.shadowRoots?.[0]?.children ?? [])
  const card = parts.find((node) => attributeOf(node, 'class') === 'player')
  const box = parts.find((node) => attributeOf(node, 'class') === 'box')
  const buttons: { name: string; node: DomNode }[] = []
  const collect = (node: DomNode) => {
    if (node.localName === 'button') {
      buttons.push({ name: attributeOf(node, 'aria-label') ?? textOf(node), node })
    }
    for (const child of node.children ?? []) collect(child)
  }
  if (card) collect(card)
  return { hosts, card, box, buttons }
}

async function displayOf(session: CDPSession, node: DomNode): Promise<string> {
  const { computedStyle } = (await session.send('CSS.getComputedStyleForNode', {
    nodeId: node.nodeId,
  })) as { computedStyle: { name: string; value: string }[] }
  return computedStyle.find((entry) => entry.name === 'display')?.value ?? ''
}

async function borderBox(session: CDPSession, node: DomNode) {
  const { model } = (await session.send('DOM.getBoxModel', { nodeId: node.nodeId })) as {
    model: { border: number[] }
  }
  const [x1 = 0, y1 = 0, x2 = 0, , , y3 = 0] = model.border
  return { x: x1, y: y1, width: x2 - x1, height: y3 - y1 }
}

export async function playerView(page: Page): Promise<PlayerView> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable')
    await session.send('CSS.enable')
    const { hosts, card, box, buttons } = await playerNodes(session)
    const cards = hosts.flatMap((host) =>
      (host.shadowRoots?.[0]?.children ?? []).filter(
        (node) => attributeOf(node, 'class') === 'player',
      ),
    ).length
    const open = card !== undefined && (await displayOf(session, card)) !== 'none'
    const boxShown = box !== undefined && (await displayOf(session, box)) !== 'none'
    const hintNode = card?.children?.find((node) => attributeOf(node, 'class') === 'hint')
    const hint =
      hintNode && attributeOf(hintNode, 'hidden') === undefined ? textOf(hintNode) : undefined
    return {
      hosts: hosts.length,
      cards,
      open,
      outcome: card && attributeOf(card, 'data-outcome'),
      step: card && attributeOf(card, 'data-step'),
      side: card && attributeOf(card, 'data-side'),
      occluded: card !== undefined && attributeOf(card, 'data-occluded') === 'true',
      text: open ? textOf(card) : '',
      hint: open ? hint : undefined,
      buttons: open ? buttons.map((button) => button.name) : [],
      highlight: boxShown ? await borderBox(session, box) : undefined,
    }
  } finally {
    await session.detach()
  }
}

/** Clicks a player button with the real mouse (the root is closed to locators). */
export async function clickInPlayer(page: Page, name: string): Promise<void> {
  const session = await page.context().newCDPSession(page)
  let point: { x: number; y: number } | undefined
  try {
    await session.send('DOM.enable')
    const { buttons } = await playerNodes(session)
    const button = buttons.find((candidate) => candidate.name === name)
    if (!button) throw new Error(`No player button named ${name}`)
    const box = await borderBox(session, button.node)
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  } finally {
    await session.detach()
  }
  await page.mouse.click(point.x, point.y)
}

/** The player card's markup, for an accessibility check outside the closed root. */
export async function playerCardMarkup(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable')
    const { card } = await playerNodes(session)
    if (!card) throw new Error('no player card')
    const { outerHTML } = await session.send('DOM.getOuterHTML', { nodeId: card.nodeId })
    return outerHTML
  } finally {
    await session.detach()
  }
}

/** The rules of ContextLayer's adopted stylesheet, read from its isolated world. */
export async function overlayStyles(page: Page): Promise<string> {
  return (await evaluateInContentScript(
    page,
    `[...chrome.dom.openOrClosedShadowRoot(document.querySelector('[data-contextlayer-root]')).adoptedStyleSheets]
      .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\\n')`,
  )) as string
}

/** The class of the element focused inside ContextLayer's closed root, if any. */
export async function focusedInPlayer(page: Page): Promise<string | null> {
  return (await evaluateInContentScript(
    page,
    `chrome.dom.openOrClosedShadowRoot(document.querySelector('[data-contextlayer-root]'))?.activeElement?.className ?? null`,
  )) as string | null
}
