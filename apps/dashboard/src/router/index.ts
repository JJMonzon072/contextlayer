import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type RouterHistory,
} from 'vue-router'

import type { SessionStore } from '../features/auth/session'

declare module 'vue-router' {
  interface RouteMeta {
    /** Signed-in users only; others go to /login?redirect=… */
    requiresAuth?: boolean
    /** Signed-out users only (login, register). */
    guestOnly?: boolean
  }
}

/** Only same-app paths: `//evil.example` or `https://…` would be an open redirect. */
export function safeRedirect(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : undefined
}

export async function sessionGuard(
  to: RouteLocationNormalized,
  store: SessionStore,
): Promise<RouteLocationRaw | true> {
  try {
    await store.ensureLoaded()
  } catch {
    // API unreachable: public pages still render; protected ones go to login,
    // which reports the connection problem when the user tries to sign in.
  }
  if (to.meta.requiresAuth && !store.isAuthenticated.value) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  }
  if (to.meta.guestOnly && store.isAuthenticated.value) return { name: 'home' }
  // Decided here, after the session is loaded: a route-level `redirect` would
  // run before this guard and see an empty workspace list.
  if (to.name === 'home') return homeLocation(store)
  return true
}

/** Where `/` leads: the first workspace, or onboarding when there is none. */
export function homeLocation(store: SessionStore): RouteLocationRaw {
  const [first] = store.workspaces.value
  return first
    ? { name: 'workspace', params: { workspaceId: first.id } }
    : { name: 'workspace-new' }
}

export function createAppRouter(store: SessionStore, history: RouterHistory = createWebHistory()) {
  const router = createRouter({
    history,
    routes: [
      {
        path: '/',
        name: 'home',
        meta: { requiresAuth: true },
        // Never rendered: sessionGuard always redirects `home` to a workspace or onboarding.
        component: { render: () => null },
      },
      {
        path: '/login',
        name: 'login',
        meta: { guestOnly: true },
        component: () => import('../features/auth/LoginPage.vue'),
      },
      {
        path: '/register',
        name: 'register',
        meta: { guestOnly: true },
        component: () => import('../features/auth/RegisterPage.vue'),
      },
      {
        path: '/workspaces/new',
        name: 'workspace-new',
        meta: { requiresAuth: true },
        component: () => import('../features/workspaces/CreateWorkspacePage.vue'),
      },
      {
        path: '/workspaces/:workspaceId',
        meta: { requiresAuth: true },
        component: () => import('../features/workspaces/AppShell.vue'),
        children: [
          {
            path: '',
            name: 'workspace',
            component: () => import('../features/workspaces/WorkspaceOverviewPage.vue'),
          },
          {
            path: 'applications',
            name: 'applications',
            component: () => import('../features/applications/ApplicationsPage.vue'),
          },
          {
            path: 'applications/:applicationId',
            name: 'application',
            component: () => import('../features/applications/ApplicationPage.vue'),
          },
          {
            path: 'guides/:guideId',
            name: 'guide',
            component: () => import('../features/guides/GuideEditorPage.vue'),
          },
          {
            path: 'guides/:guideId/versions/:version(\\d+)',
            name: 'guide-version',
            component: () => import('../features/guides/GuideVersionPage.vue'),
          },
          {
            path: 'connected-browsers',
            name: 'connected-browsers',
            component: () => import('../features/extension/ConnectedBrowsersPage.vue'),
          },
          {
            path: 'members',
            name: 'members',
            component: () => import('../features/workspaces/MembersPage.vue'),
          },
        ],
      },
      {
        path: '/status',
        name: 'status',
        component: () => import('../features/system-status/SystemStatusPage.vue'),
      },
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: () => import('../components/NotFoundPage.vue'),
      },
    ],
  })

  router.beforeEach((to) => sessionGuard(to, store))
  return router
}
