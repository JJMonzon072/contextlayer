import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as authApi from '../src/features/auth/auth-api'
import RegisterPage from '../src/features/auth/RegisterPage.vue'
import { apiError, sessionResponse, testRouter } from './fixtures'

vi.mock('../src/features/auth/auth-api')

async function mountRegister() {
  const router = testRouter()
  await router.push('/register')
  const wrapper = mount(RegisterPage, { global: { plugins: [router] } })
  const fill = async (values: Record<string, string>) => {
    const inputs = wrapper.findAll('input')
    const [name, email, password, confirm] = inputs
    await name?.setValue(values.name ?? '')
    await email?.setValue(values.email ?? '')
    await password?.setValue(values.password ?? '')
    await confirm?.setValue(values.confirm ?? '')
  }
  return { wrapper, router, fill }
}

const valid = {
  name: 'Alice',
  email: 'alice@example.com',
  password: 'correct horse battery staple',
  confirm: 'correct horse battery staple',
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.register).mockReset()
  })

  it('applies the shared password rules and checks the confirmation', async () => {
    const { wrapper, fill } = await mountRegister()

    await fill({ ...valid, password: 'short', confirm: 'different' })
    await wrapper.find('form').trigger('submit')

    expect(wrapper.text()).toContain('Use at least 12 characters.')
    expect(wrapper.text()).toContain('The passwords do not match.')
    expect(authApi.register).not.toHaveBeenCalled()
  })

  it('reports an email that is already registered', async () => {
    vi.mocked(authApi.register).mockRejectedValue(
      apiError(409, 'CONFLICT', 'An account with this email already exists.'),
    )
    const { wrapper, fill } = await mountRegister()

    await fill(valid)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toBe('An account with this email already exists.')
  })

  it('creates the account and continues to workspace onboarding', async () => {
    vi.mocked(authApi.register).mockResolvedValue(sessionResponse([]))
    const { wrapper, router, fill } = await mountRegister()

    await fill(valid)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(authApi.register).toHaveBeenCalledWith({
      displayName: 'Alice',
      email: 'alice@example.com',
      password: 'correct horse battery staple',
    })
    expect(router.currentRoute.value.name).toBe('workspace-new')
  })

  it('labels every field for assistive technology', async () => {
    const { wrapper } = await mountRegister()

    for (const input of wrapper.findAll('input')) {
      const id = input.attributes('id')
      expect(id).toBeTruthy()
      expect(wrapper.find(`label[for="${id ?? ''}"]`).exists()).toBe(true)
    }
  })
})
