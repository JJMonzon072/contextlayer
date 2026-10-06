import type { PublishedGuideSummary } from '@contextlayer/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

import type { SiteStatusData } from '../src/messaging/protocol'

/**
 * The popup's Play (Phase 6a), mounted with Vue in jsdom against a fake
 * `chrome`: it lists the guides the worker returned for this page and asks
 * the worker to play the version it listed; the real popup is covered by the
 * Playwright suite.
 */

const TAB = 7
const guide = (title: string, version = 1): PublishedGuideSummary => ({
  guideId: crypto.randomUUID(),
  applicationId: '01a10a2e-864b-75bc-8800-aa3f01a05320',
  version,
  title,
  description: '',
  stepCount: 3,
  publishedAt: '2026-10-06T09:00:00.000Z',
  startUrlPattern: null,
})

const active = (guides: PublishedGuideSummary[]): SiteStatusData => ({
  state: 'active',
  origin: 'http://127.0.0.1:4400',
  pattern: 'http://127.0.0.1:4400/*',
  applications: ['Demo CRM'],
  guides,
  moreGuides: false,
})

let sent: { type: string }[] = []
let answer: (message: { type: string }) => unknown
let app: App | undefined
let root: HTMLElement
let close = vi.fn()

beforeEach(() => {
  sent = []
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'own-extension-id',
      sendMessage: (message: { type: string }) => {
        sent.push(message)
        return Promise.resolve(answer(message))
      },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { query: () => Promise.resolve([{ id: TAB }]) },
  })
  close = vi.fn()
  vi.spyOn(window, 'close').mockImplementation(close)
  root = document.createElement('div')
  document.body.append(root)
})

afterEach(() => {
  app?.unmount()
  root.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount() {
  const { default: SiteCard } = await import('../src/popup/SiteCard.vue')
  app = createApp(SiteCard)
  app.mount(root)
  await vi.waitFor(() => {
    expect(root.querySelector('[data-testid="site"]')?.getAttribute('data-state')).toBe('active')
  })
}

const playButtons = () => [...root.querySelectorAll<HTMLButtonElement>('[data-testid="play"]')]

describe('playing a guide from the popup', () => {
  it('offers Play for each guide listed for this page, named after the guide', async () => {
    answer = () => ({ ok: true, data: active([guide('Create a customer'), guide('Export')]) })

    await mount()

    expect(playButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Play Create a customer',
      'Play Export',
    ])
    expect(playButtons().map((button) => button.textContent.trim())).toEqual(['Play', 'Play'])
  })

  it('asks the worker to play the version listed, then closes', async () => {
    const listed = guide('Create a customer', 4)
    answer = (message) =>
      message.type === 'site.status'
        ? { ok: true, data: active([listed]) }
        : { ok: true, data: { runId: 'Rn1_run-id-0123456789abcdef' } }
    await mount()

    playButtons()[0]?.click()
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce()
    })

    expect(sent.at(-1)).toEqual({
      type: 'player.start',
      tabId: TAB,
      guideId: listed.guideId,
      version: 4,
    })
  })

  it('says why a guide did not start, and lists what is published now', async () => {
    const first = guide('Create a customer', 1)
    let published = [first]
    answer = (message) => {
      if (message.type === 'site.status') return { ok: true, data: active(published) }
      published = [{ ...first, version: 2, title: 'Create a customer (v2)' }]
      return {
        ok: false,
        error: { code: 'STALE', message: 'This guide was published again.' },
      }
    }
    await mount()

    playButtons()[0]?.click()
    await vi.waitFor(() => {
      expect(root.querySelector('[role="alert"]')?.textContent).toBe(
        'This guide was published again.',
      )
    })
    await nextTick()

    expect(close).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="guide"]')?.textContent).toContain('(v2)')
  })
})
