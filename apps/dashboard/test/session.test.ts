import { describe, expect, it, vi } from 'vitest'

import type * as authApi from '../src/features/auth/auth-api'
import { createSessionStore } from '../src/features/auth/session'
import { HttpError } from '../src/lib/http'
import { ACME, apiError, GLOBEX, sessionResponse } from './fixtures'

function fakeApi(overrides: Partial<typeof authApi> = {}): typeof authApi {
  return {
    fetchSession: vi.fn(() => Promise.resolve(sessionResponse())),
    login: vi.fn(() => Promise.resolve(sessionResponse())),
    register: vi.fn(() => Promise.resolve(sessionResponse([]))),
    logout: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  }
}

describe('session store', () => {
  it('is anonymous when the API answers 401', async () => {
    const store = createSessionStore(
      fakeApi({ fetchSession: () => Promise.reject(apiError(401, 'UNAUTHORIZED', 'x')) }),
    )

    await store.ensureLoaded()

    expect(store.state.value.status).toBe('anonymous')
    expect(store.isAuthenticated.value).toBe(false)
  })

  it('exposes the user and workspaces of a valid session', async () => {
    const store = createSessionStore(fakeApi())

    await store.ensureLoaded()

    expect(store.user.value?.email).toBe('alice@example.com')
    expect(store.workspaces.value).toEqual([ACME])
  })

  it('shares one request between concurrent loads', async () => {
    const api = fakeApi()
    const store = createSessionStore(api)

    await Promise.all([store.ensureLoaded(), store.ensureLoaded(), store.ensureLoaded()])

    expect(api.fetchSession).toHaveBeenCalledOnce()
  })

  it('surfaces other failures instead of pretending the user is signed out', async () => {
    const store = createSessionStore(
      fakeApi({ fetchSession: () => Promise.reject(new HttpError('network', 'offline')) }),
    )

    await expect(store.ensureLoaded()).rejects.toThrow('offline')
    expect(store.state.value.status).toBe('unknown')
  })

  it('forgets the identity on logout even if the API is unreachable', async () => {
    const store = createSessionStore(
      fakeApi({ logout: () => Promise.reject(new HttpError('network', 'offline')) }),
    )
    await store.login({ email: 'alice@example.com', password: 'x' })

    await expect(store.logout()).rejects.toThrow()

    expect(store.state.value.status).toBe('anonymous')
  })

  it('adds and removes workspaces locally after the API confirmed them', async () => {
    const store = createSessionStore(fakeApi())
    await store.ensureLoaded()

    store.addWorkspace(GLOBEX)
    store.removeWorkspace(ACME.id)

    expect(store.workspaces.value).toEqual([GLOBEX])
  })
})
