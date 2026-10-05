import type { WorkspaceRole } from '@contextlayer/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as applicationsApi from '../src/features/applications/applications-api'
import ApplicationPage from '../src/features/applications/ApplicationPage.vue'
import * as authApi from '../src/features/auth/auth-api'
import { session } from '../src/features/auth/session'
import * as guidesApi from '../src/features/guides/guides-api'
import { apiError, CRM, guide, sessionResponse, testRouter, workspaceAs } from './fixtures'

vi.mock('../src/features/auth/auth-api')
vi.mock('../src/features/applications/applications-api')
vi.mock('../src/features/guides/guides-api')

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
    vi.mocked(guidesApi.listGuides).mockReset().mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(guidesApi.createGuide).mockReset()
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

  it('lists the guides of the application for editors, with their status', async () => {
    const {
      steps: _steps,
      startUrlPattern: _pattern,
      ...summary
    } = guide({
      status: 'published',
      latestVersion: 2,
      hasUnpublishedChanges: true,
    })
    vi.mocked(guidesApi.listGuides).mockResolvedValue({ items: [summary], nextCursor: null })
    const { wrapper, workspace } = await mountAs('editor')

    const row = wrapper.get('[data-testid="guide-row"]')
    expect(row.text()).toContain('Create a customer')
    expect(row.get('[data-testid="guide-status"]').text()).toBe('Published · v2')
    expect(row.text()).toContain('Unpublished changes')
    expect(guidesApi.listGuides).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ applicationId: CRM.id }),
    )
  })

  it('creates a guide and opens the editor', async () => {
    vi.mocked(guidesApi.createGuide).mockResolvedValue(guide())
    const { wrapper, router, workspace } = await mountAs('editor')

    const form = wrapper.get('form[aria-label="Create a guide"]')
    await form.get('input').setValue('Create a customer')
    await form.trigger('submit')
    await flushPromises()

    expect(guidesApi.createGuide).toHaveBeenCalledWith(workspace.id, {
      applicationId: CRM.id,
      title: 'Create a customer',
    })
    expect(router.currentRoute.value.name).toBe('guide')
  })

  it('tells members that editors prepare the guides', async () => {
    const { wrapper } = await mountAs('member')

    expect(wrapper.find('form[aria-label="Create a guide"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Editors prepare the guides')
    expect(guidesApi.listGuides).not.toHaveBeenCalled()
  })
})
