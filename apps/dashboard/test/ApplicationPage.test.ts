import type { WorkspaceRole } from '@contextlayer/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as applicationsApi from '../src/features/applications/applications-api'
import ApplicationPage from '../src/features/applications/ApplicationPage.vue'
import * as authApi from '../src/features/auth/auth-api'
import { session } from '../src/features/auth/session'
import { apiError, CRM, sessionResponse, testRouter, workspaceAs } from './fixtures'

vi.mock('../src/features/auth/auth-api')
vi.mock('../src/features/applications/applications-api')

async function mountAs(role: WorkspaceRole) {
  const workspace = workspaceAs(role)
  vi.mocked(authApi.login).mockResolvedValue(sessionResponse([workspace]))
  await session.login({ email: 'alice@example.com', password: 'x' })
  const router = testRouter()
  await router.push(`/workspaces/${workspace.id}/applications/${CRM.id}`)
  const wrapper = mount(ApplicationPage, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router, workspace }
}

const button = (wrapper: Awaited<ReturnType<typeof mountAs>>['wrapper'], text: string) =>
  wrapper.findAll('button').find((candidate) => candidate.text() === text)

describe('ApplicationPage', () => {
  beforeEach(() => {
    vi.mocked(applicationsApi.getApplication).mockReset().mockResolvedValue(CRM)
    vi.mocked(applicationsApi.updateApplication).mockReset()
    vi.mocked(applicationsApi.deleteApplication).mockReset()
  })

  it('shows the application and hides management from editors and members', async () => {
    for (const role of ['editor', 'member'] as const) {
      const { wrapper } = await mountAs(role)
      expect(wrapper.get('[data-testid="application-name"]').text()).toBe('Acme CRM')
      expect(button(wrapper, 'Edit')).toBeUndefined()
      expect(button(wrapper, 'Delete')).toBeUndefined()
    }
  })

  it('saves edits made by an admin', async () => {
    vi.mocked(applicationsApi.updateApplication).mockResolvedValue({ ...CRM, name: 'Sales CRM' })
    const { wrapper, workspace } = await mountAs('admin')

    await button(wrapper, 'Edit')?.trigger('click')
    await wrapper.get('input').setValue('Sales CRM')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(applicationsApi.updateApplication).toHaveBeenCalledWith(workspace.id, CRM.id, {
      name: 'Sales CRM',
      origins: CRM.origins,
    })
    expect(wrapper.get('[data-testid="application-name"]').text()).toBe('Sales CRM')
  })

  it('explains why an application with guides cannot be deleted', async () => {
    vi.mocked(applicationsApi.deleteApplication).mockRejectedValue(
      apiError(409, 'CONFLICT', 'This application has guides, so it cannot be deleted.'),
    )
    const { wrapper, router } = await mountAs('owner')

    await button(wrapper, 'Delete')?.trigger('click')
    await button(wrapper, 'Delete application')?.trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('has guides')
    expect(router.currentRoute.value.name).toBe('application')
  })

  it('shows not-found answers from the API', async () => {
    vi.mocked(applicationsApi.getApplication).mockRejectedValue(
      apiError(404, 'NOT_FOUND', 'Application not found.'),
    )
    const { wrapper } = await mountAs('owner')

    expect(wrapper.get('[role="alert"]').text()).toBe('Application not found.')
  })
})
