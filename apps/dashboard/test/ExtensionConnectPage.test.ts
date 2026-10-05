import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as authApi from '../src/features/auth/auth-api'
import { session } from '../src/features/auth/session'
import ExtensionConnectPage from '../src/features/extension/ExtensionConnectPage.vue'
import * as extensionApi from '../src/features/extension/extension-api'
import { ACME, apiError, GLOBEX, sessionResponse, testRouter } from './fixtures'

vi.mock('../src/features/auth/auth-api')
vi.mock('../src/features/extension/extension-api')

const STATE = 's'.repeat(43)
const CHALLENGE = 'c'.repeat(43)
const CODE = `clc_${'k'.repeat(43)}`
const CONNECTED = {
  ok: true,
  connection: { user: { displayName: 'Alice' }, workspace: { name: 'Globex' } },
}

const sendMessage = vi.fn<(id: string, message: unknown) => Promise<unknown>>()

function installExtension() {
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
}

async function mountPage(query: Record<string, string> = { state: STATE, challenge: CHALLENGE }) {
  vi.mocked(authApi.login).mockResolvedValue(sessionResponse([ACME, GLOBEX]))
  await session.login({ email: 'alice@example.com', password: 'x' })
  const router = testRouter()
  await router.push({ name: 'extension-connect', query })
  const wrapper = mount(ExtensionConnectPage, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

const button = (wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper'], text: string) =>
  wrapper.findAll('button').find((candidate) => candidate.text() === text)

async function choose(wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper'], name: string) {
  const label = wrapper.findAll('label').find((candidate) => candidate.text().includes(name))
  await label?.get('input').setValue(true)
}

describe('ExtensionConnectPage', () => {
  beforeEach(() => {
    sendMessage.mockReset()
    vi.mocked(extensionApi.createConnectionCode).mockReset()
    vi.mocked(extensionApi.createConnectionCode).mockResolvedValue({
      code: CODE,
      expiresAt: '2026-10-05T12:01:00.000Z',
    })
    installExtension()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses a link without a valid state and challenge', async () => {
    const queries: Record<string, string>[] = [
      {},
      { state: STATE },
      { state: 'short', challenge: CHALLENGE },
    ]
    for (const query of queries) {
      const { wrapper } = await mountPage(query)

      expect(wrapper.find('[data-testid="invalid-link"]').exists()).toBe(true)
      expect(wrapper.find('form').exists()).toBe(false)
    }
  })

  it('explains when the extension is not installed for this dashboard', async () => {
    vi.unstubAllGlobals()
    const { wrapper } = await mountPage()

    expect(wrapper.find('[data-testid="extension-missing"]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('shows the account and requires an explicit workspace choice', async () => {
    const { wrapper } = await mountPage()

    expect(wrapper.get('[data-testid="connect-account"]').text()).toContain('alice@example.com')
    const radios = wrapper.findAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios.some((radio) => (radio.element as HTMLInputElement).checked)).toBe(false)
    expect(button(wrapper, 'Connect')?.attributes('disabled')).toBeDefined()

    await choose(wrapper, 'Globex')

    expect(button(wrapper, 'Connect')?.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="connect-summary"]').text()).toContain('Globex')
  })

  it('issues a code for the chosen workspace and hands only code and state to the extension', async () => {
    sendMessage.mockResolvedValue(CONNECTED)
    const { wrapper, router } = await mountPage()
    await choose(wrapper, 'Globex')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(extensionApi.createConnectionCode).toHaveBeenCalledWith({
      workspaceId: GLOBEX.id,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      label: expect.any(String) as string,
    })
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(DEVELOPMENT_EXTENSION_ID, {
      type: 'connection.complete',
      state: STATE,
      code: CODE,
    })
    expect(wrapper.get('[data-testid="connect-success"]').text()).toContain('Globex')
    // The code never reaches the page or its URL.
    expect(wrapper.html()).not.toContain(CODE)
    expect(router.currentRoute.value.fullPath).not.toContain(CODE)
  })

  it('reports success only after the extension confirms', async () => {
    let answer: (value: unknown) => void = () => undefined
    sendMessage.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { wrapper } = await mountPage()
    await choose(wrapper, 'Globex')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[data-testid="connect-success"]').exists()).toBe(false)
    expect(button(wrapper, 'Connect')?.attributes('aria-busy')).toBe('true')

    answer(CONNECTED)
    await flushPromises()
    expect(wrapper.find('[data-testid="connect-success"]').exists()).toBe(true)
  })

  it('reports a refusal from the extension and does not claim success', async () => {
    for (const [reply, text] of [
      [{ ok: false, error: 'unknown-attempt' }, 'no longer waiting'],
      [{ ok: false, error: 'exchange-failed' }, 'could not complete'],
      [{ ok: true, connection: null }, 'did not answer'],
      [{ ok: true, connection: { accessToken: 'x' } }, 'did not answer'],
    ] as const) {
      sendMessage.mockResolvedValueOnce(reply)
      const { wrapper } = await mountPage()
      await choose(wrapper, 'Acme')

      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('[data-testid="connect-success"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="connect-failed"]').text()).toContain(text)
    }
  })

  it('treats an extension that throws as no answer', async () => {
    sendMessage.mockRejectedValue(new Error('Could not establish connection.'))
    const { wrapper } = await mountPage()
    await choose(wrapper, 'Acme')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="connect-failed"]').text()).toContain('did not answer')
  })

  it('keeps the form when the API refuses to issue a code', async () => {
    vi.mocked(extensionApi.createConnectionCode).mockRejectedValue(
      apiError(404, 'NOT_FOUND', 'Workspace not found.'),
    )
    const { wrapper } = await mountPage()
    await choose(wrapper, 'Acme')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('Workspace not found.')
    expect(wrapper.find('form').exists()).toBe(true)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('cancels the pending attempt in the extension', async () => {
    sendMessage.mockResolvedValue({ ok: true, connection: null })
    const { wrapper } = await mountPage()

    await button(wrapper, 'Cancel')?.trigger('click')
    await flushPromises()

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(DEVELOPMENT_EXTENSION_ID, {
      type: 'connection.cancel',
      state: STATE,
    })
    expect(extensionApi.createConnectionCode).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="connect-cancelled"]').exists()).toBe(true)
  })

  it('signs out and returns to the login page with the same link', async () => {
    vi.mocked(authApi.logout).mockResolvedValue(undefined)
    const { wrapper, router } = await mountPage()

    await button(wrapper, 'Use another account')?.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe(
      `/extension/connect?state=${STATE}&challenge=${CHALLENGE}`,
    )
  })
})
