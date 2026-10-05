import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as applicationsApi from '../src/features/applications/applications-api'
import * as authApi from '../src/features/auth/auth-api'
import { session } from '../src/features/auth/session'
import GuideVersionPage from '../src/features/guides/GuideVersionPage.vue'
import * as guidesApi from '../src/features/guides/guides-api'
import { apiError, CRM, guide, sessionResponse, testRouter, workspaceAs } from './fixtures'

vi.mock('../src/features/auth/auth-api')
vi.mock('../src/features/applications/applications-api')
vi.mock('../src/features/guides/guides-api')

async function mountVersion(version: number) {
  const workspace = workspaceAs('editor')
  vi.mocked(authApi.login).mockResolvedValue(sessionResponse([workspace]))
  await session.login({ email: 'alice@example.com', password: 'x' })
  const router = testRouter()
  await router.push(`/workspaces/${workspace.id}/guides/${guide().id}/versions/${String(version)}`)
  const wrapper = mount(GuideVersionPage, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, workspace }
}

describe('GuideVersionPage', () => {
  beforeEach(() => {
    vi.mocked(applicationsApi.getApplication).mockReset().mockResolvedValue(CRM)
    vi.mocked(guidesApi.getVersion).mockReset()
  })

  it('shows the frozen snapshot read-only', async () => {
    const draft = guide()
    vi.mocked(guidesApi.getVersion).mockResolvedValue({
      guideId: draft.id,
      version: 2,
      publishedAt: '2026-10-04T10:00:00.000Z',
      publishedBy: { userId: 'u', displayName: 'Alice' },
      stepCount: 2,
      snapshot: {
        version: 1,
        guide: {
          id: draft.id,
          applicationId: CRM.id,
          title: 'Create a customer',
          description: 'From the Customers page.',
          startUrlPattern: { pathname: '/customers' },
        },
        steps: draft.steps,
      },
    })
    const { wrapper, workspace } = await mountVersion(2)

    expect(guidesApi.getVersion).toHaveBeenCalledWith(workspace.id, draft.id, 2)
    expect(wrapper.get('[data-testid="version-number"]').text()).toBe('Version 2')
    expect(
      wrapper.findAll('[data-testid="version-step"]').map((step) => step.find('h2').text()),
    ).toEqual(['Open Customers', 'Click New customer'])
    expect(wrapper.text()).toContain('Read-only snapshot')
    expect(wrapper.text()).toContain('by Alice')
    expect(wrapper.text()).toContain('/customers')
    expect(wrapper.findAll('input, textarea, select, button')).toHaveLength(0)
  })

  it('reports a version that does not exist', async () => {
    vi.mocked(guidesApi.getVersion).mockRejectedValue(
      apiError(404, 'NOT_FOUND', 'Version not found.'),
    )
    const { wrapper } = await mountVersion(9)

    expect(wrapper.get('[role="alert"]').text()).toBe('Version not found.')
  })
})
