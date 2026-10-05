import { createMemoryHistory } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'

import type * as authApi from '../src/features/auth/auth-api'
import { createSessionStore } from '../src/features/auth/session'
import { createAppRouter, safeRedirect } from '../src/router'
import { ACME, apiError, sessionResponse } from './fixtures'

function routerFor(session: 'anonymous' | 'with-workspace' | 'without-workspace') {
  const api = {
    fetchSession: vi.fn(() =>
      session === 'anonymous'
        ? Promise.reject(apiError(401, 'UNAUTHORIZED', 'Authentication required'))
        : Promise.resolve(sessionResponse(session === 'with-workspace' ? [ACME] : [])),
    ),
  } as unknown as typeof authApi
  return createAppRouter(createSessionStore(api), createMemoryHistory())
}

describe('route guards', () => {
  it('sends signed-out users to /login and remembers where they were going', async () => {
    const router = routerFor('anonymous')

    await router.push(`/workspaces/${ACME.id}/members`)

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe(`/workspaces/${ACME.id}/members`)
  })

  it('sends a signed-in user from / to their first workspace', async () => {
    const router = routerFor('with-workspace')

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('workspace')
    expect(router.currentRoute.value.params.workspaceId).toBe(ACME.id)
  })

  it('sends a signed-in user without workspaces to onboarding', async () => {
    const router = routerFor('without-workspace')

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('workspace-new')
  })

  it('keeps signed-in users away from the login and register pages', async () => {
    const router = routerFor('with-workspace')

    await router.push('/login')

    expect(router.currentRoute.value.name).toBe('workspace')
  })

  it('leaves public pages public', async () => {
    const router = routerFor('anonymous')

    await router.push('/status')

    expect(router.currentRoute.value.name).toBe('status')
  })
})

describe('safeRedirect', () => {
  it.each(['/workspaces/abc', '/'])('accepts the in-app path %s', (value) => {
    expect(safeRedirect(value)).toBe(value)
  })

  it.each(['//evil.example', 'https://evil.example', 'javascript:alert(1)', undefined, ['/x']])(
    'rejects %j (open redirect)',
    (value) => {
      expect(safeRedirect(value)).toBeUndefined()
    },
  )
})
