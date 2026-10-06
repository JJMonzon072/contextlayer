import { randomUUID } from 'node:crypto'

import {
  applicationsPath,
  AUTH_PATHS,
  guidePublishPath,
  guidesPath,
  guideStepsPath,
  WORKSPACES_PATH,
} from '@contextlayer/shared'
import { expect, request, type APIRequestContext } from '@playwright/test'

import { E2E_DASHBOARD_URL } from '../environment'

/**
 * Seeds the e2e database through the dashboard's own origin (`/api` proxy),
 * with its CSRF header, like the dashboard does. Each account has its own
 * cookie jar, separate from the browser under test.
 */
export const PASSWORD = 'correct horse battery staple'

export interface Account {
  email: string
  displayName: string
  api: APIRequestContext
}

/** The dashboard forwards /api/* to the API. */
const at = (path: string) => `/api${path}`

async function ok<T>(response: Awaited<ReturnType<APIRequestContext['post']>>): Promise<T> {
  expect(response.ok(), `${response.url()} answered ${String(response.status())}`).toBe(true)
  return (await response.json()) as T
}

export async function createAccount(displayName = 'Alice'): Promise<Account> {
  const api = await request.newContext({
    baseURL: E2E_DASHBOARD_URL,
    extraHTTPHeaders: { origin: E2E_DASHBOARD_URL },
  })
  const email = `e2e-${randomUUID()}@example.test`
  await ok(
    await api.post(at(AUTH_PATHS.register), { data: { email, password: PASSWORD, displayName } }),
  )
  return { email, displayName, api }
}

export async function createWorkspace(account: Account, name: string): Promise<string> {
  const workspace = await ok<{ id: string }>(
    await account.api.post(at(WORKSPACES_PATH), { data: { name } }),
  )
  return workspace.id
}

export async function createApplication(
  account: Account,
  workspaceId: string,
  name: string,
  origins: string[],
): Promise<string> {
  const application = await ok<{ id: string }>(
    await account.api.post(at(applicationsPath(workspaceId)), { data: { name, origins } }),
  )
  return application.id
}

/** A guide with one step per title (no target), published once. */
export async function publishGuide(
  account: Account,
  workspaceId: string,
  applicationId: string,
  title: string,
  steps: string[] = ['Open the menu'],
  startUrlPattern?: Record<string, string>,
): Promise<string> {
  const guide = await ok<{ id: string; revision: number }>(
    await account.api.post(at(guidesPath(workspaceId)), { data: { applicationId, title } }),
  )
  await ok(
    await account.api.put(at(guideStepsPath(workspaceId, guide.id)), {
      data: {
        expectedRevision: guide.revision,
        steps: steps.map((stepTitle) => ({
          title: stepTitle,
          body: {
            version: 1,
            blocks: [{ type: 'paragraph', children: [{ type: 'text', text: stepTitle }] }],
          },
        })),
      },
    }),
  )
  if (startUrlPattern) {
    await ok(
      await account.api.patch(at(guidesPath(workspaceId, guide.id)), {
        data: { startUrlPattern },
      }),
    )
  }
  await ok(await account.api.post(at(guidePublishPath(workspaceId, guide.id))))
  return guide.id
}

/** Publishes a guide's current draft as a new version; returns its number. */
export async function publishDraft(
  account: Account,
  workspaceId: string,
  guideId: string,
): Promise<number> {
  const published = await ok<{ version: { version: number } }>(
    await account.api.post(at(guidePublishPath(workspaceId, guideId))),
  )
  return published.version.version
}
