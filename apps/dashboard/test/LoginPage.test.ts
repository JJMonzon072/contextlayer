import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as authApi from '../src/features/auth/auth-api'
import LoginPage from '../src/features/auth/LoginPage.vue'
import { apiError, sessionResponse, testRouter } from './fixtures'

vi.mock('../src/features/auth/auth-api')

async function mountLogin(path = '/login') {
  const router = testRouter()
  await router.push(path)
  const wrapper = mount(LoginPage, { global: { plugins: [router] } })
  return { wrapper, router }
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.login).mockReset()
  })

  it('validates required fields without calling the API', async () => {
    const { wrapper } = await mountLogin()

    await wrapper.find('form').trigger('submit')

    expect(wrapper.text()).toContain('Enter your email.')
    expect(wrapper.text()).toContain('Enter your password.')
    expect(wrapper.find('input[type="email"]').attributes('aria-invalid')).toBe('true')
    expect(authApi.login).not.toHaveBeenCalled()
  })

  it('shows the API message for bad credentials and clears the password', async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      apiError(401, 'UNAUTHORIZED', 'Invalid email or password.'),
    )
    const { wrapper } = await mountLogin()

    await wrapper.find('input[type="email"]').setValue('alice@example.com')
    await wrapper.find('input[type="password"]').setValue('wrong password')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toBe('Invalid email or password.')
    expect((wrapper.find('input[type="password"]').element as HTMLInputElement).value).toBe('')
  })

  it('explains rate limiting with the retry delay', async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      Object.assign(apiError(429, 'RATE_LIMITED', 'Too many requests'), {
        retryAfterSeconds: 600,
      }),
    )
    const { wrapper } = await mountLogin()

    await wrapper.find('input[type="email"]').setValue('alice@example.com')
    await wrapper.find('input[type="password"]').setValue('whatever')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toBe(
      'Too many attempts. Try again in 10 minutes.',
    )
  })

  it('signs in and continues to the page the user was going to', async () => {
    vi.mocked(authApi.login).mockResolvedValue(sessionResponse())
    const { wrapper, router } = await mountLogin('/login?redirect=/workspaces/abc/members')

    await wrapper.find('input[type="email"]').setValue('alice@example.com')
    await wrapper.find('input[type="password"]').setValue('correct horse battery staple')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(authApi.login).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'correct horse battery staple',
    })
    expect(router.currentRoute.value.fullPath).toBe('/workspaces/abc/members')
  })

  it('ignores an external redirect target', async () => {
    vi.mocked(authApi.login).mockResolvedValue(sessionResponse())
    const { wrapper, router } = await mountLogin('/login?redirect=//evil.example')

    await wrapper.find('input[type="email"]').setValue('alice@example.com')
    await wrapper.find('input[type="password"]').setValue('correct horse battery staple')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/')
  })
})
