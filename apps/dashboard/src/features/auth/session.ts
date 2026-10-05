import type {
  LoginRequest,
  RegisterRequest,
  SessionResponse,
  User,
  WorkspaceSummary,
} from '@contextlayer/shared'
import { computed, readonly, shallowRef } from 'vue'

import { HttpError } from '../../lib/http'
import * as authApi from './auth-api'

/**
 * Who is signed in, as reported by the API. The session token itself lives
 * only in the HttpOnly cookie: nothing here (or in localStorage) can read it.
 */
export type SessionState =
  | { status: 'unknown' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: User; workspaces: WorkspaceSummary[] }

export function createSessionStore(api: typeof authApi = authApi) {
  const state = shallowRef<SessionState>({ status: 'unknown' })
  let loading: Promise<void> | undefined

  function apply(response: SessionResponse) {
    state.value = { status: 'authenticated', ...response }
  }

  async function load(): Promise<void> {
    try {
      apply(await api.fetchSession())
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        state.value = { status: 'anonymous' }
        return
      }
      throw error
    } finally {
      loading = undefined
    }
  }

  return {
    state: readonly(state),
    isAuthenticated: computed(() => state.value.status === 'authenticated'),
    user: computed(() => (state.value.status === 'authenticated' ? state.value.user : undefined)),
    workspaces: computed(() =>
      state.value.status === 'authenticated' ? state.value.workspaces : [],
    ),

    /** Loads the session once; concurrent callers share the same request. */
    ensureLoaded(): Promise<void> {
      if (state.value.status !== 'unknown') return Promise.resolve()
      loading ??= load()
      return loading
    },

    async register(input: RegisterRequest): Promise<void> {
      apply(await api.register(input))
    },

    async login(input: LoginRequest): Promise<void> {
      apply(await api.login(input))
    },

    async logout(): Promise<void> {
      try {
        await api.logout()
      } finally {
        // Even if the API was unreachable, forget the identity locally.
        state.value = { status: 'anonymous' }
      }
    },

    addWorkspace(workspace: WorkspaceSummary): void {
      if (state.value.status !== 'authenticated') return
      state.value = { ...state.value, workspaces: [...state.value.workspaces, workspace] }
    },

    removeWorkspace(workspaceId: string): void {
      if (state.value.status !== 'authenticated') return
      state.value = {
        ...state.value,
        workspaces: state.value.workspaces.filter((w) => w.id !== workspaceId),
      }
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>

/** The app-wide instance (tests create their own with fake APIs). */
export const session = createSessionStore()
