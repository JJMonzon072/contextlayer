import type { SessionResponse, WorkspaceSummary } from '@contextlayer/shared'
import { createMemoryHistory, createRouter } from 'vue-router'

import { HttpError } from '../src/lib/http'

export const ACME: WorkspaceSummary = {
  id: '01a10a2e-864b-75bc-8800-aa3f01a05314',
  name: 'Acme',
  role: 'owner',
  createdAt: '2026-10-05T10:00:00.000Z',
}

export const GLOBEX: WorkspaceSummary = {
  id: '01a10a2e-864b-75bc-8800-aa3f01a05315',
  name: 'Globex',
  role: 'member',
  createdAt: '2026-10-05T11:00:00.000Z',
}

export function sessionResponse(workspaces: WorkspaceSummary[] = [ACME]): SessionResponse {
  return {
    user: {
      id: '01a10a2e-864b-75bc-8800-aa3f01a05300',
      email: 'alice@example.com',
      displayName: 'Alice',
      createdAt: '2026-10-05T09:00:00.000Z',
    },
    workspaces,
  }
}

export function apiError(status: number, code: HttpError['code'], apiMessage: string) {
  return new HttpError('status', `Unexpected HTTP status ${status}.`, {
    status,
    ...(code && { code }),
    apiMessage,
  })
}

const Empty = { render: () => null }

/** A router with the app's route names and empty components. */
export function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: Empty },
      { path: '/login', name: 'login', component: Empty },
      { path: '/register', name: 'register', component: Empty },
      { path: '/workspaces/new', name: 'workspace-new', component: Empty },
      { path: '/workspaces/:workspaceId', name: 'workspace', component: Empty },
      { path: '/workspaces/:workspaceId/members', name: 'members', component: Empty },
    ],
  })
}
