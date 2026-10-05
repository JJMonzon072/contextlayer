import type { Application, Guide, WorkspaceRole } from '@contextlayer/shared'
import { expect } from 'vitest'

import { register, type TestApp } from './app.js'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Cookie-authenticated request, the way the dashboard sends it (no Origin, like a same-origin fetch in tests). */
export function call(app: TestApp, method: Method, url: string, cookie?: string, payload?: object) {
  return app.inject({
    method,
    url,
    ...(cookie && { headers: { cookie } }),
    ...(payload && { payload }),
  })
}

export async function createWorkspace(app: TestApp, cookie: string, name: string) {
  const response = await call(app, 'POST', '/v1/workspaces', cookie, { name })
  expect(response.statusCode).toBe(201)
  return response.json<{ id: string }>()
}

export async function addMember(
  app: TestApp,
  ownerCookie: string,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
) {
  const response = await call(app, 'POST', `/v1/workspaces/${workspaceId}/members`, ownerCookie, {
    email,
    role,
  })
  expect(response.statusCode).toBe(201)
}

export async function createApplication(
  app: TestApp,
  cookie: string,
  workspaceId: string,
  body: { name: string; origins: string[] } = {
    name: 'Acme CRM',
    origins: ['https://crm.acme.test'],
  },
): Promise<Application> {
  const response = await call(
    app,
    'POST',
    `/v1/workspaces/${workspaceId}/applications`,
    cookie,
    body,
  )
  expect(response.statusCode, response.body).toBe(201)
  return response.json<Application>()
}

export async function createGuide(
  app: TestApp,
  cookie: string,
  workspaceId: string,
  applicationId: string,
  title = 'Create a customer',
): Promise<Guide> {
  const response = await call(app, 'POST', `/v1/workspaces/${workspaceId}/guides`, cookie, {
    applicationId,
    title,
  })
  expect(response.statusCode, response.body).toBe(201)
  return response.json<Guide>()
}

/** A rich-text body with one paragraph. */
export function body(text: string) {
  return { version: 1, blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }
}

/**
 * One workspace with a member of every role, so permission tests read as a
 * table: `people.owner.cookie`, `people.editor.cookie`…
 */
export async function workspaceWithEveryRole(app: TestApp, name = 'Acme') {
  const owner = await register(app, `owner@${name.toLowerCase()}.test`, `${name} Owner`)
  const workspace = await createWorkspace(app, owner.cookie, name)
  const people: Record<WorkspaceRole, { cookie: string; userId: string }> = {
    owner,
    admin: await register(app, `admin@${name.toLowerCase()}.test`, `${name} Admin`),
    editor: await register(app, `editor@${name.toLowerCase()}.test`, `${name} Editor`),
    member: await register(app, `member@${name.toLowerCase()}.test`, `${name} Member`),
  }
  for (const role of ['admin', 'editor', 'member'] as const) {
    await addMember(app, owner.cookie, workspace.id, `${role}@${name.toLowerCase()}.test`, role)
  }
  return { workspace, people }
}
