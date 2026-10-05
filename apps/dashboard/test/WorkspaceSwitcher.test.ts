import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import * as authApi from '../src/features/auth/auth-api'
import { session } from '../src/features/auth/session'
import WorkspaceSwitcher from '../src/features/workspaces/WorkspaceSwitcher.vue'
import { ACME, GLOBEX, sessionResponse, testRouter } from './fixtures'

vi.mock('../src/features/auth/auth-api')

async function mountSwitcher(path: string) {
  vi.mocked(authApi.login).mockResolvedValue(sessionResponse([ACME, GLOBEX]))
  await session.login({ email: 'alice@example.com', password: 'x' })
  const router = testRouter()
  await router.push(path)
  const wrapper = mount(WorkspaceSwitcher, {
    props: { currentId: ACME.id },
    global: { plugins: [router] },
  })
  return { wrapper, router }
}

describe('WorkspaceSwitcher', () => {
  it('lists the user workspaces with the current one selected', async () => {
    const { wrapper } = await mountSwitcher(`/workspaces/${ACME.id}`)

    const options = wrapper.findAll('option').map((option) => option.text())
    expect(options).toEqual(['Acme', 'Globex', '+ New workspace…'])
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe(ACME.id)
  })

  it('switches workspace and keeps the current tab', async () => {
    const { wrapper, router } = await mountSwitcher(`/workspaces/${ACME.id}/members`)

    await wrapper.find('select').setValue(GLOBEX.id)
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('members')
    expect(router.currentRoute.value.params.workspaceId).toBe(GLOBEX.id)
  })

  it('opens workspace creation from the last option', async () => {
    const { wrapper, router } = await mountSwitcher(`/workspaces/${ACME.id}`)

    await wrapper.find('select').setValue('__new__')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('workspace-new')
  })
})
