import type { WorkspaceRole } from '@contextlayer/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as applicationsApi from '../src/features/applications/applications-api'
import * as authApi from '../src/features/auth/auth-api'
import { session } from '../src/features/auth/session'
import GuideEditorPage from '../src/features/guides/GuideEditorPage.vue'
import * as guidesApi from '../src/features/guides/guides-api'
import { apiError, CRM, guide, sessionResponse, testRouter, workspaceAs } from './fixtures'

vi.mock('../src/features/auth/auth-api')
vi.mock('../src/features/applications/applications-api')
vi.mock('../src/features/guides/guides-api')

async function mountEditor(role: WorkspaceRole = 'editor') {
  const workspace = workspaceAs(role)
  vi.mocked(authApi.login).mockResolvedValue(sessionResponse([workspace]))
  await session.login({ email: 'alice@example.com', password: 'x' })
  const router = testRouter()
  await router.push(`/workspaces/${workspace.id}/guides/${guide().id}`)
  const wrapper = mount(GuideEditorPage, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router, workspace }
}

type Wrapper = Awaited<ReturnType<typeof mountEditor>>['wrapper']
const button = (wrapper: Wrapper, text: string) =>
  wrapper
    .findAll('button')
    .find((candidate) => candidate.text().replace(/\s+/g, ' ').trim() === text)
const stepTitles = (wrapper: Wrapper) =>
  wrapper
    .findAll('[data-testid="step-card"] input')
    .map((input) => (input.element as HTMLInputElement).value)

describe('GuideEditorPage', () => {
  beforeEach(() => {
    vi.mocked(guidesApi.getGuide).mockReset().mockResolvedValue(guide())
    vi.mocked(guidesApi.replaceSteps).mockReset()
    vi.mocked(guidesApi.updateGuide).mockReset()
    vi.mocked(applicationsApi.getApplication).mockReset().mockResolvedValue(CRM)
  })

  it('shows the draft with its steps and nothing to save', async () => {
    const { wrapper } = await mountEditor()

    expect(wrapper.get('[data-testid="guide-title"]').text()).toBe('Create a customer')
    expect(stepTitles(wrapper)).toEqual(['Open Customers', 'Click New customer'])
    expect(button(wrapper, 'Save draft')?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Acme CRM')
    expect(wrapper.get('[data-testid="step-target"]').text()).toMatch(/Not captured yet/)
  })

  it('reorders steps with the move buttons and saves the new order', async () => {
    vi.mocked(guidesApi.replaceSteps).mockImplementation((_, __, body) =>
      Promise.resolve(guide({ revision: 3 })).then((saved) => {
        expect(body.steps.map((step) => step.title)).toEqual([
          'Click New customer',
          'Open Customers',
        ])
        return saved
      }),
    )
    const { wrapper, workspace } = await mountEditor()

    await button(wrapper, '↓Move step 1 down')?.trigger('click')
    expect(stepTitles(wrapper)).toEqual(['Click New customer', 'Open Customers'])
    expect(wrapper.find('[data-testid="unsaved"]').exists()).toBe(true)

    await button(wrapper, 'Save draft')?.trigger('click')
    await flushPromises()

    expect(guidesApi.replaceSteps).toHaveBeenCalledWith(
      workspace.id,
      guide().id,
      expect.objectContaining({ expectedRevision: 2 }),
    )
    expect(guidesApi.updateGuide).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="notice"]').text()).toBe('Draft saved.')
  })

  it('adds and removes steps', async () => {
    const { wrapper } = await mountEditor()

    await button(wrapper, 'Add step')?.trigger('click')
    expect(wrapper.findAll('[data-testid="step-card"]')).toHaveLength(3)
    await button(wrapper, 'Remove step 1')?.trigger('click')

    expect(stepTitles(wrapper)).toEqual(['Click New customer', ''])
  })

  it('points at invalid steps instead of saving', async () => {
    const { wrapper } = await mountEditor()

    await button(wrapper, 'Add step')?.trigger('click')
    await button(wrapper, 'Save draft')?.trigger('click')
    await flushPromises()

    expect(guidesApi.replaceSteps).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Give the step a title of 1 to 120 characters.')
    expect(wrapper.get('[role="alert"]').text()).toContain('Fix the highlighted fields')
  })

  it('saves metadata first, then steps on the next revision', async () => {
    vi.mocked(guidesApi.updateGuide).mockResolvedValue(guide({ title: 'Renamed', revision: 3 }))
    vi.mocked(guidesApi.replaceSteps).mockResolvedValue(guide({ title: 'Renamed', revision: 4 }))
    const { wrapper } = await mountEditor()

    await wrapper.get('input').setValue('Renamed')
    await wrapper.findAll('[data-testid="step-card"] input')[0]?.setValue('Open the Customers page')
    await button(wrapper, 'Save draft')?.trigger('click')
    await flushPromises()

    expect(vi.mocked(guidesApi.updateGuide).mock.calls[0]?.[2]).toMatchObject({
      title: 'Renamed',
      expectedRevision: 2,
    })
    expect(vi.mocked(guidesApi.replaceSteps).mock.calls[0]?.[2]).toMatchObject({
      expectedRevision: 3,
    })
  })

  it('explains a conflicting edit and offers to reload', async () => {
    vi.mocked(guidesApi.replaceSteps).mockRejectedValue(
      apiError(
        409,
        'CONFLICT',
        'This guide was changed by someone else. Reload it to see the latest draft.',
      ),
    )
    const { wrapper } = await mountEditor()

    await button(wrapper, '↓Move step 1 down')?.trigger('click')
    await button(wrapper, 'Save draft')?.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('changed by someone else')

    vi.mocked(guidesApi.getGuide).mockResolvedValue(guide({ revision: 5, title: 'Their version' }))
    await button(wrapper, 'Reload the latest draft')?.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="guide-title"]').text()).toBe('Their version')
    expect(wrapper.find('[data-testid="unsaved"]').exists()).toBe(false)
  })

  it('keeps an archived guide read-only until it is restored', async () => {
    vi.mocked(guidesApi.getGuide).mockResolvedValue(
      guide({ status: 'archived', archivedAt: '2026-10-05T13:00:00.000Z' }),
    )
    const { wrapper } = await mountEditor()

    expect(button(wrapper, 'Save draft')).toBeUndefined()
    expect(button(wrapper, 'Add step')).toBeUndefined()
    expect(wrapper.get('input').attributes('readonly')).toBeDefined()
    expect(button(wrapper, 'Restore')).toBeDefined()
  })
})
