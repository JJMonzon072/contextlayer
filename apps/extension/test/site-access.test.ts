import {
  EXTENSION_PATHS,
  originMatchPattern,
  type ExtensionApplication,
  type PublishedGuideSummary,
} from '@contextlayer/shared'
import { describe, expect, it } from 'vitest'

import { ApiUnreachableError } from '../src/background/api-client'
import { createAuth } from '../src/background/auth'
import {
  createSiteAccess,
  scriptId,
  SCRIPT_ID_PREFIX,
  siteOrigin,
  type PageSender,
  type SiteChrome,
} from '../src/background/site-access'
import { createVault } from '../src/background/vault'
import { fakeApi, json, memoryStorage, NOW, tokenResponse, type Call } from './support/fakes'

const API_PATTERN = 'http://api.test:80/*'
const CRM = 'https://crm.acme.test'
const CRM_PATTERN = 'https://crm.acme.test:443/*'
const WIKI = 'http://localhost:4179'
const CRM_TAB = 1
const CRM_TAB_2 = 2
const WIKI_TAB = 3

const app = (name: string, origins: string[]): ExtensionApplication => ({
  id: crypto.randomUUID(),
  name,
  origins,
})

const guide: PublishedGuideSummary = {
  guideId: '01a10a2e-864b-75bc-8800-aa3f01a05330',
  applicationId: '01a10a2e-864b-75bc-8800-aa3f01a05320',
  version: 1,
  title: 'Create a customer',
  description: '',
  stepCount: 2,
  publishedAt: '2026-10-05T12:00:00.000Z',
}

/** Chrome as site access sees it: grants, tabs, registrations, injections, messages. */
function fakeChrome() {
  const granted = new Set([API_PATTERN])
  const required = new Set([API_PATTERN])
  const tabs = new Map<number, string>([
    [CRM_TAB, `${CRM}/customers`],
    [CRM_TAB_2, `${CRM}/deals`],
    [WIKI_TAB, `${WIKI}/home`],
  ])
  const registered = new Map<string, string>([['someone-elses-script', 'https://x.test:443/*']])
  const injected: number[] = []
  const sent: { tabId: number; message: unknown; documentId: string }[] = []
  const chrome: SiteChrome = {
    hasHostAccess: (pattern) => Promise.resolve(granted.has(pattern)),
    removeHostAccess: (pattern) => {
      if (required.has(pattern)) return Promise.resolve(false)
      granted.delete(pattern)
      return Promise.resolve(true)
    },
    tabUrl: (tabId) => Promise.resolve(tabs.get(tabId)),
    registeredScripts: () => Promise.resolve([...registered.keys()].map((id) => ({ id }))),
    registerScripts: (scripts) => {
      for (const script of scripts) {
        if (registered.has(script.id)) return Promise.reject(new Error('Duplicate script ID'))
        registered.set(script.id, script.pattern)
      }
      return Promise.resolve()
    },
    unregisterScripts: (ids) => {
      for (const id of ids) registered.delete(id)
      return Promise.resolve()
    },
    tabsMatching: (pattern) =>
      Promise.resolve(
        [...tabs]
          .filter(([, url]) => originMatchPattern(new URL(url).origin) === pattern)
          .map(([id]) => id),
      ),
    inject: (tabId) => {
      injected.push(tabId)
      return Promise.resolve()
    },
    sendToTab: (tabId, message, documentId) => {
      sent.push({ tabId, message, documentId })
      return Promise.resolve()
    },
  }
  const ours = () =>
    [...registered].filter(([id]) => id.startsWith(SCRIPT_ID_PREFIX)).map(([, pattern]) => pattern)
  return { chrome, granted, tabs, registered, injected, sent, ours }
}

async function setup(
  options: {
    apps?: ExtensionApplication[]
    api?: (call: Call) => Response | Promise<Response> | undefined
    connected?: boolean
  } = {},
) {
  let apps = options.apps ?? [app('Acme CRM', [CRM])]
  const storage = memoryStorage()
  const vault = createVault(storage)
  const { api, calls } = fakeApi((call) => {
    const override = options.api?.(call)
    if (override) return override
    if (call.path === EXTENSION_PATHS.applications) return json(200, { items: apps })
    if (call.path.startsWith(`${EXTENSION_PATHS.guides}?`)) {
      return json(200, { items: [guide], nextCursor: null })
    }
    return json(404)
  })
  const auth = createAuth({ vault, api, now: () => NOW, onEnded: () => Promise.resolve() })
  if (options.connected ?? true) await auth.save(tokenResponse())
  const fake = fakeChrome()
  const site = createSiteAccess({
    vault,
    auth,
    chrome: fake.chrome,
    apiPattern: API_PATTERN,
    now: () => NOW,
  })
  return {
    ...fake,
    site,
    vault,
    auth,
    calls,
    setApps: (next: ExtensionApplication[]) => {
      apps = next
    },
  }
}

/** What Chrome reports for a content script in a top frame. */
const sender = (tabId: number, url: string, overrides: Partial<PageSender> = {}): PageSender => ({
  url,
  origin: new URL(url).origin,
  frameId: 0,
  documentId: `doc-${String(tabId)}`,
  tab: { id: tabId } as chrome.tabs.Tab,
  ...overrides,
})

describe('siteOrigin and scriptId', () => {
  it('accepts http(s) pages only', () => {
    expect(siteOrigin('https://crm.acme.test/customers?id=1')).toBe(CRM)
    for (const url of ['chrome://extensions', 'file:///tmp/a.html', 'about:blank', undefined]) {
      expect(siteOrigin(url)).toBeUndefined()
    }
  })

  it('derives a stable, prefixed registration id per origin', async () => {
    expect(await scriptId(CRM)).toBe(await scriptId(CRM))
    expect(await scriptId(CRM)).not.toBe(await scriptId(WIKI))
    expect(await scriptId(CRM)).toMatch(/^cl-site-[0-9a-f]{24}$/)
  })
})

describe('site status', () => {
  it('tells apart unsupported pages, no connection, withheld API access and unregistered sites', async () => {
    const { site, tabs, granted } = await setup()
    tabs.set(9, 'chrome://settings')
    expect(await site.status(9)).toEqual({ state: 'unsupported' })
    expect(await site.status(WIKI_TAB)).toEqual({
      state: 'not-registered',
      origin: WIKI,
      workspace: 'Acme',
    })

    granted.delete(API_PATTERN)
    expect(await site.status(CRM_TAB)).toEqual({ state: 'api-withheld', origin: CRM })

    const disconnected = await setup({ connected: false })
    expect(await disconnected.site.status(CRM_TAB)).toEqual({ state: 'disconnected', origin: CRM })
  })

  it('distinguishes registered, granted and activated', async () => {
    const { site, granted } = await setup()

    expect(await site.status(CRM_TAB)).toMatchObject({
      state: 'available',
      pattern: CRM_PATTERN,
      applications: ['Acme CRM'],
      permission: 'missing',
    })
    granted.add(CRM_PATTERN)
    expect(await site.status(CRM_TAB)).toMatchObject({
      state: 'available',
      permission: 'granted',
    })
  })

  it('lists every application that shares the origin', async () => {
    const { site } = await setup({ apps: [app('Acme CRM', [CRM]), app('Acme Billing', [CRM])] })

    expect(await site.status(CRM_TAB)).toMatchObject({
      applications: ['Acme CRM', 'Acme Billing'],
    })
  })
})

describe('enabling a site', () => {
  it('needs Chrome access: without it nothing is recorded or registered', async () => {
    const { site, vault, ours } = await setup()

    expect(await site.enable(CRM_TAB)).toMatchObject({ state: 'available', permission: 'missing' })
    expect(await vault.readSites('01a10a2e-864b-75bc-8800-aa3f01a05314')).toEqual([])
    expect(ours()).toEqual([])
  })

  it('registers the exact origin, injects into its open tabs and lists its published guides', async () => {
    const { site, granted, ours, injected, calls } = await setup()
    granted.add(CRM_PATTERN)

    expect(await site.enable(CRM_TAB)).toEqual({
      state: 'active',
      origin: CRM,
      pattern: CRM_PATTERN,
      applications: ['Acme CRM'],
      guides: [guide],
      moreGuides: false,
    })
    expect(ours()).toEqual([CRM_PATTERN])
    expect(injected.sort()).toEqual([CRM_TAB, CRM_TAB_2])
    expect(calls.map((call) => call.path)).toContain(
      `${EXTENSION_PATHS.guides}?origin=${encodeURIComponent(CRM)}`,
    )
  })

  it('refuses an origin that is not a registered application', async () => {
    const { site, granted, ours } = await setup()
    granted.add(originMatchPattern(WIKI))

    expect(await site.enable(WIKI_TAB)).toMatchObject({ state: 'not-registered' })
    expect(ours()).toEqual([])
  })

  it('reconciles idempotently and never touches registrations that are not its own', async () => {
    const { site, granted, registered, injected } = await setup()
    granted.add(CRM_PATTERN)
    await site.enable(CRM_TAB)
    injected.length = 0

    await site.reconcile()
    await Promise.all([site.reconcile(), site.reconcile()])

    expect([...registered.keys()].filter((id) => id.startsWith(SCRIPT_ID_PREFIX))).toHaveLength(1)
    expect(registered.has('someone-elses-script')).toBe(true)
    expect(injected).toEqual([])
  })

  it('re-injects every enabled site after install, update or browser start', async () => {
    const { site, granted, injected } = await setup()
    granted.add(CRM_PATTERN)
    await site.enable(CRM_TAB)
    injected.length = 0

    await site.reconcile({ injectAll: true })

    expect(injected.sort()).toEqual([CRM_TAB, CRM_TAB_2])
  })
})

describe("the connection's applications", () => {
  it('lists every application with its origins, on where ContextLayer runs', async () => {
    const { site, granted } = await setup({
      apps: [app('Acme CRM', [CRM]), app('Acme Wiki', [WIKI, 'https://wiki.acme.test'])],
    })
    granted.add(CRM_PATTERN)
    await site.enable(CRM_TAB)

    expect(await site.applications()).toEqual({
      applications: [
        {
          id: expect.any(String) as string,
          name: 'Acme CRM',
          origins: [{ origin: CRM, on: true }],
        },
        {
          id: expect.any(String) as string,
          name: 'Acme Wiki',
          origins: [
            { origin: WIKI, on: false },
            { origin: 'https://wiki.acme.test', on: false },
          ],
        },
      ],
    })
  })

  it('knows nothing when disconnected or when the API is down with nothing cached', async () => {
    const disconnected = await setup({ connected: false })
    expect(await disconnected.site.applications()).toEqual({ applications: null })

    const offline = await setup({ api: () => Promise.reject(new ApiUnreachableError('offline')) })
    expect(await offline.site.applications()).toEqual({ applications: null })
  })
})

describe('pages asking to run (page.hello)', () => {
  it('authorizes the top frame of an enabled, registered and granted site', async () => {
    const { site, granted } = await setup()
    granted.add(CRM_PATTERN)
    await site.enable(CRM_TAB)

    expect(await site.hello(sender(CRM_TAB, `${CRM}/customers`))).toEqual({ active: true })
  })

  it('refuses subframes, missing documents, mismatched origins and other sites', async () => {
    const { site, granted } = await setup()
    granted.add(CRM_PATTERN)
    await site.enable(CRM_TAB)

    for (const refused of [
      sender(CRM_TAB, `${CRM}/customers`, { frameId: 4 }),
      sender(CRM_TAB, `${CRM}/customers`, { documentId: undefined }),
      sender(CRM_TAB, `${CRM}/customers`, { origin: WIKI }),
      sender(CRM_TAB, `${CRM}/customers`, { tab: undefined }),
      sender(WIKI_TAB, `${WIKI}/home`),
      sender(CRM_TAB, 'chrome://settings', { origin: 'chrome://settings' }),
    ]) {
      expect(await site.hello(refused)).toEqual({ active: false })
    }
  })

  it('refuses every page once disconnected', async () => {
    const { site, granted, vault } = await setup()
    granted.add(CRM_PATTERN)
    await site.enable(CRM_TAB)
    await vault.clearConnection(false, NOW)

    expect(await site.hello(sender(CRM_TAB, `${CRM}/customers`))).toEqual({ active: false })
  })
})

describe('losing access', () => {
  async function enabledWithPage() {
    const context = await setup()
    context.granted.add(CRM_PATTERN)
    await context.site.enable(CRM_TAB)
    await context.site.hello(sender(CRM_TAB, `${CRM}/customers`))
    return context
  }

  const DEACTIVATED = [
    { tabId: CRM_TAB, message: { type: 'page.deactivate' }, documentId: `doc-${String(CRM_TAB)}` },
  ]

  it('Chrome access removed: registration dropped, open pages stopped, popup says so', async () => {
    const { site, granted, ours, sent } = await enabledWithPage()

    granted.delete(CRM_PATTERN)
    await site.reconcile()

    expect(ours()).toEqual([])
    expect(sent).toEqual(DEACTIVATED)
    expect(await site.status(CRM_TAB)).toMatchObject({ state: 'permission-missing' })
  })

  it('application deleted or origin changed: noticed on the next status', async () => {
    const { site, ours, sent, setApps } = await enabledWithPage()

    setApps([app('Acme CRM', ['https://crm2.acme.test'])])

    expect(await site.status(CRM_TAB)).toMatchObject({ state: 'not-registered' })
    expect(ours()).toEqual([])
    expect(sent).toEqual(DEACTIVATED)
  })

  it('workspace switched: the other workspace has nothing enabled', async () => {
    const { site, auth, ours, sent, vault } = await enabledWithPage()

    const globex = tokenResponse({ grantId: '01a10a2e-864b-75bc-8800-aa3f01a05399' })
    globex.connection.workspace = { id: '01a10a2e-864b-75bc-8800-aa3f01a05315', name: 'Globex' }
    await auth.save(globex)
    await site.reconcile()

    expect(ours()).toEqual([])
    expect(sent).toEqual(DEACTIVATED)
    expect(await vault.readSites('01a10a2e-864b-75bc-8800-aa3f01a05315')).toEqual([])
  })

  it('disconnected: every registration goes and pages stop', async () => {
    const { site, vault, ours, sent } = await enabledWithPage()

    await vault.clearConnection(false, NOW)
    await site.reconcile()

    expect(ours()).toEqual([])
    expect(sent).toEqual(DEACTIVATED)
  })

  it('turned off by the user: Chrome access is given back too', async () => {
    const { site, granted, ours, sent } = await enabledWithPage()

    expect(await site.disable(CRM_TAB)).toMatchObject({ state: 'available', permission: 'missing' })
    expect(granted.has(CRM_PATTERN)).toBe(false)
    expect(ours()).toEqual([])
    expect(sent).toEqual(DEACTIVATED)
  })

  it('a closed tab is forgotten', async () => {
    const { site, vault } = await enabledWithPage()

    await site.pageClosed(CRM_TAB)

    expect(await vault.readPages()).toEqual({})
  })
})

describe('when the API cannot be reached', () => {
  it('keeps what runs, adds nothing new, and says guides could not be loaded', async () => {
    let offline = false
    const context = await setup({
      api: () => (offline ? Promise.reject(new ApiUnreachableError('offline')) : undefined),
    })
    context.granted.add(CRM_PATTERN)
    await context.site.enable(CRM_TAB)
    offline = true

    expect(await context.site.status(CRM_TAB)).toMatchObject({ state: 'active', guides: null })
    await context.site.reconcile()
    expect(context.ours()).toEqual([CRM_PATTERN])
  })

  it('without any known application list, reports the API as unreachable', async () => {
    const { site } = await setup({
      api: () => Promise.reject(new ApiUnreachableError('offline')),
    })

    expect(await site.status(CRM_TAB)).toEqual({ state: 'api-unreachable', origin: CRM })
  })

  it('a revoked connection found by any request stops everything', async () => {
    let revoked = false
    const context = await setup({ api: () => (revoked ? json(401) : undefined) })
    context.granted.add(CRM_PATTERN)
    await context.site.enable(CRM_TAB)
    revoked = true

    expect(await context.site.status(CRM_TAB)).toEqual({ state: 'disconnected', origin: CRM })
    expect(context.ours()).toEqual([])
  })
})
