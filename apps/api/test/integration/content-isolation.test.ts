import { randomUUID } from 'node:crypto'

import { apiErrorSchema, guideSchema } from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, register, type TestApp } from './support/app.js'
import {
  body,
  call,
  createApplication,
  createGuide,
  workspaceWithEveryRole,
} from './support/content.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp

afterAll(() => database.close())
beforeEach(async () => {
  await resetTestDatabase(database)
  app = await buildTestApp()
})
afterEach(() => app.close())

/**
 * Workspace A owns application A and guide A (two steps, version 1
 * published); workspace B is another tenant with its own content.
 */
async function twoTenants() {
  const a = await workspaceWithEveryRole(app, 'Acme')
  const b = await workspaceWithEveryRole(app, 'Globex')
  const outsider = await register(app, 'outsider@example.test', 'Outsider')
  const applicationA = await createApplication(app, a.people.owner.cookie, a.workspace.id)
  const guideA = await createGuide(app, a.people.editor.cookie, a.workspace.id, applicationA.id)
  const guideBase = `/v1/workspaces/${a.workspace.id}/guides/${guideA.id}`
  await call(app, 'PUT', `${guideBase}/steps`, a.people.editor.cookie, {
    expectedRevision: 1,
    steps: [
      { title: 'One', body: body('One.') },
      { title: 'Two', body: body('Two.') },
    ],
  })
  expect((await call(app, 'POST', `${guideBase}/publish`, a.people.editor.cookie)).statusCode).toBe(
    201,
  )
  const applicationB = await createApplication(app, b.people.owner.cookie, b.workspace.id, {
    name: 'Globex ERP',
    origins: ['https://erp.globex.test'],
  })
  return { a, b, outsider, applicationA, guideA, applicationB }
}

type Actor =
  'ownerOfA' | 'adminOfA' | 'editorOfA' | 'memberOfA' | 'ownerOfB' | 'noMembership' | 'anonymous'

const OPERATIONS = [
  'read application',
  'rename application',
  'list guides',
  'read guide',
  'rename guide',
  'replace steps',
  'publish',
  'list versions',
  'read version 1',
  'archive guide',
  'delete application',
] as const

describe('content tenant isolation matrix (workspace A)', () => {
  const expectations: Record<Actor, number[]> = {
    ownerOfA: [200, 200, 200, 200, 200, 200, 201, 200, 200, 204, 409],
    adminOfA: [200, 200, 200, 200, 200, 200, 201, 200, 200, 204, 409],
    editorOfA: [200, 403, 200, 200, 200, 200, 201, 200, 200, 204, 403],
    memberOfA: [200, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
    // Not a member of A: 404 everywhere, exactly like a workspace that does not exist.
    ownerOfB: Array<number>(OPERATIONS.length).fill(404),
    noMembership: Array<number>(OPERATIONS.length).fill(404),
    anonymous: Array<number>(OPERATIONS.length).fill(401),
  }

  it.each(Object.entries(expectations) as [Actor, number[]][])(
    `%s gets %j for: ${OPERATIONS.join(', ')}`,
    async (actor, expected) => {
      const { a, b, outsider, applicationA, guideA } = await twoTenants()
      const cookies: Record<Actor, string | undefined> = {
        ownerOfA: a.people.owner.cookie,
        adminOfA: a.people.admin.cookie,
        editorOfA: a.people.editor.cookie,
        memberOfA: a.people.member.cookie,
        ownerOfB: b.people.owner.cookie,
        noMembership: outsider.cookie,
        anonymous: undefined,
      }
      const cookie = cookies[actor]
      const workspace = `/v1/workspaces/${a.workspace.id}`
      const application = `${workspace}/applications/${applicationA.id}`
      const guide = `${workspace}/guides/${guideA.id}`
      // The harness reads the current revision as the owner, so the step
      // replacement is refused only for authorization reasons.
      const currentRevision = async () =>
        guideSchema.parse((await call(app, 'GET', guide, a.people.owner.cookie)).json()).revision

      const statuses = [
        (await call(app, 'GET', application, cookie)).statusCode,
        (await call(app, 'PATCH', application, cookie, { name: 'Renamed' })).statusCode,
        (await call(app, 'GET', `${workspace}/guides`, cookie)).statusCode,
        (await call(app, 'GET', guide, cookie)).statusCode,
        (await call(app, 'PATCH', guide, cookie, { title: 'Renamed' })).statusCode,
        (
          await call(app, 'PUT', `${guide}/steps`, cookie, {
            expectedRevision: await currentRevision(),
            steps: [{ title: 'Replaced', body: body('Replaced.') }],
          })
        ).statusCode,
        (await call(app, 'POST', `${guide}/publish`, cookie)).statusCode,
        (await call(app, 'GET', `${guide}/versions`, cookie)).statusCode,
        (await call(app, 'GET', `${guide}/versions/1`, cookie)).statusCode,
        (await call(app, 'DELETE', guide, cookie)).statusCode,
        (await call(app, 'DELETE', application, cookie)).statusCode,
      ]

      expect(statuses).toEqual(expected)
    },
  )
})

describe("another workspace's ids inside your own workspace", () => {
  it('behave exactly like ids that do not exist, for every content route', async () => {
    const { a, b, applicationA, guideA } = await twoTenants()
    const ownWorkspace = `/v1/workspaces/${b.workspace.id}`
    const cookie = b.people.owner.cookie
    const requests = (applicationId: string, guideId: string) =>
      [
        ['GET', `${ownWorkspace}/applications/${applicationId}`],
        ['PATCH', `${ownWorkspace}/applications/${applicationId}`, { name: 'Mine now' }],
        ['DELETE', `${ownWorkspace}/applications/${applicationId}`],
        ['GET', `${ownWorkspace}/guides/${guideId}`],
        ['PATCH', `${ownWorkspace}/guides/${guideId}`, { title: 'Mine now' }],
        ['PUT', `${ownWorkspace}/guides/${guideId}/steps`, { expectedRevision: 2, steps: [] }],
        ['POST', `${ownWorkspace}/guides/${guideId}/publish`],
        ['GET', `${ownWorkspace}/guides/${guideId}/versions`],
        ['GET', `${ownWorkspace}/guides/${guideId}/versions/1`],
        ['DELETE', `${ownWorkspace}/guides/${guideId}`],
        ['POST', `${ownWorkspace}/guides/${guideId}/restore`],
        ['POST', `${ownWorkspace}/guides`, { applicationId, title: 'Borrowed' }],
      ] as const

    const foreign = requests(applicationA.id, guideA.id)
    const missing = requests(randomUUID(), randomUUID())
    for (const [index, [method, url, payload]] of foreign.entries()) {
      const [missingMethod, missingUrl, missingPayload] = missing[index] ?? []
      const foreignResponse = await call(app, method, url, cookie, payload)
      const missingResponse = await call(
        app,
        missingMethod ?? 'GET',
        missingUrl ?? '',
        cookie,
        missingPayload,
      )

      expect(foreignResponse.statusCode, `${method} ${url}`).toBe(404)
      const { requestId: _a, ...foreignError } = apiErrorSchema.parse(foreignResponse.json()).error
      const { requestId: _b, ...missingError } = apiErrorSchema.parse(missingResponse.json()).error
      expect(foreignError).toEqual(missingError)
    }

    // And nothing in workspace A changed.
    const guide = guideSchema.parse(
      (
        await call(
          app,
          'GET',
          `/v1/workspaces/${a.workspace.id}/guides/${guideA.id}`,
          a.people.editor.cookie,
        )
      ).json(),
    )
    expect(guide).toMatchObject({ title: guideA.title, status: 'published', revision: 2 })
    expect(guide.steps.map((step) => step.title)).toEqual(['One', 'Two'])
  })
})

describe('CSRF on content routes', () => {
  it('refuses a cross-site publish before any work is done', async () => {
    const { a, guideA } = await twoTenants()

    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${a.workspace.id}/guides/${guideA.id}/publish`,
      headers: { cookie: a.people.editor.cookie, origin: 'https://evil.example' },
    })

    expect(response.statusCode).toBe(403)
    const versions = await call(
      app,
      'GET',
      `/v1/workspaces/${a.workspace.id}/guides/${guideA.id}/versions`,
      a.people.editor.cookie,
    )
    expect(versions.json<{ items: unknown[] }>().items).toHaveLength(1)
  })
})
