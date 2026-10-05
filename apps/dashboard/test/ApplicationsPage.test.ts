import type { WorkspaceRole } from '@contextlayer/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as applicationsApi from '../src/features/applications/applications-api'
import ApplicationsPage from '../src/features/applications/ApplicationsPage.vue'
import * as authApi from '../src/features/auth/auth-api'
import { session } from '../src/features/auth/session'
import { CRM, sessionResponse, testRouter, workspaceAs } from './fixtures'

vi.mock('../src/features/auth/auth-api')
vi.mock('../src/features/applications/applications-api')

async function mountAs(role: WorkspaceRole) {
  const workspace = workspaceAs(role)
  vi.mocked(authApi.login).mockResolvedValue(sessionResponse([workspace]))
  await session.login({ email: 'alice@example.com', password: 'x' })
  const router = testRouter()
  await router.push(`/workspaces/${workspace.id}/applications`)
  const wrapper = mount(ApplicationsPage, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router, workspace }
}

describe('ApplicationsPage', () => {
  beforeEach(() => {
    vi.mocked(applicationsApi.listApplications).mockReset()
    vi.mocked(applicationsApi.createApplication).mockReset()
    vi.mocked(applicationsApi.listApplications).mockResolvedValue({
      items: [CRM],
      nextCursor: null,
    })
  })

  it('lists applications with their origins', async () => {
    const { wrapper } = await mountAs('member')

    const card = wrapper.get('[data-testid="application-card"]')
    expect(card.text()).toContain('Acme CRM')
    expect(card.text()).toContain('https://crm.acme.test')
  })

  it.each([
    ['owner', true],
    ['admin', true],
    ['editor', false],
    ['member', false],
  ] as const)('shows the register button to %s: %s', async (role, visible) => {
    const { wrapper } = await mountAs(role)

    expect(wrapper.text().includes('Register application')).toBe(visible)
  })

  it('loads the next page on demand', async () => {
    const second = { ...CRM, id: '01a10a2e-864b-75bc-8800-aa3f01a05321', name: 'Acme ERP' }
    vi.mocked(applicationsApi.listApplications)
      .mockResolvedValueOnce({ items: [CRM], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [second], nextCursor: null })
    const { wrapper, workspace } = await mountAs('owner')

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Load more')
      ?.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[data-testid="application-card"]')).toHaveLength(2)
    expect(applicationsApi.listApplications).toHaveBeenLastCalledWith(
      workspace.id,
      expect.objectContaining({ cursor: 'next-page' }),
    )
    expect(wrapper.text()).not.toContain('Load more')
  })

  it('shows why an origin is invalid without calling the API', async () => {
    const { wrapper } = await mountAs('admin')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Register application')
      ?.trigger('click')

    await wrapper.get('input').setValue('Acme CRM')
    await wrapper.get('textarea').setValue('https://crm.acme.test/login')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.text()).toContain('https://crm.acme.test/login — Remove the path')
    expect(wrapper.get('textarea').attributes('aria-invalid')).toBe('true')
    expect(applicationsApi.createApplication).not.toHaveBeenCalled()
  })

  it('registers an application with normalized origins and opens it', async () => {
    vi.mocked(applicationsApi.createApplication).mockResolvedValue(CRM)
    const { wrapper, router, workspace } = await mountAs('admin')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Register application')
      ?.trigger('click')

    await wrapper.get('input').setValue('  Acme CRM ')
    await wrapper.get('textarea').setValue('HTTPS://CRM.Acme.test/\n\nhttp://localhost:3000')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(applicationsApi.createApplication).toHaveBeenCalledWith(workspace.id, {
      name: 'Acme CRM',
      origins: ['https://crm.acme.test', 'http://localhost:3000'],
    })
    expect(router.currentRoute.value.name).toBe('application')
    expect(router.currentRoute.value.params.applicationId).toBe(CRM.id)
  })

  it('reports duplicate origins', async () => {
    const { wrapper } = await mountAs('owner')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Register application')
      ?.trigger('click')

    await wrapper.get('input').setValue('CRM')
    await wrapper.get('textarea').setValue('https://crm.acme.test\nHTTPS://crm.acme.test:443')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.text()).toContain('https://crm.acme.test is listed twice.')
  })
})
