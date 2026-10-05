import {
  apiErrorSchema,
  guideSchema,
  guideVersionListSchema,
  guideVersionSchema,
  publishGuideResponseSchema,
  type Guide,
} from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, type TestApp } from './support/app.js'
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

const guidePath = (workspaceId: string, guideId: string, rest = '') =>
  `/v1/workspaces/${workspaceId}/guides/${guideId}${rest}`

async function draftWithSteps(titles = ['Open Customers', 'Click New customer']) {
  const { workspace, people } = await workspaceWithEveryRole(app)
  const application = await createApplication(app, people.owner.cookie, workspace.id)
  const editor = people.editor.cookie
  const guide = await createGuide(app, editor, workspace.id, application.id)
  const response = await call(app, 'PUT', guidePath(workspace.id, guide.id, '/steps'), editor, {
    expectedRevision: 1,
    steps: titles.map((title) => ({ title, body: body(`${title}.`) })),
  })
  expect(response.statusCode, response.body).toBe(200)
  return { workspace, people, editor, guide: guideSchema.parse(response.json()) }
}

const publish = (cookie: string, workspaceId: string, guideId: string) =>
  call(app, 'POST', guidePath(workspaceId, guideId, '/publish'), cookie)

async function version(cookie: string, workspaceId: string, guideId: string, number: number) {
  const response = await call(
    app,
    'GET',
    guidePath(workspaceId, guideId, `/versions/${String(number)}`),
    cookie,
  )
  expect(response.statusCode).toBe(200)
  return guideVersionSchema.parse(response.json())
}

async function read(cookie: string, workspaceId: string, guideId: string): Promise<Guide> {
  return guideSchema.parse((await call(app, 'GET', guidePath(workspaceId, guideId), cookie)).json())
}

describe('publishing', () => {
  it('freezes the draft into version 1', async () => {
    const { workspace, editor, guide, people } = await draftWithSteps()

    const response = await publish(editor, workspace.id, guide.id)

    expect(response.statusCode).toBe(201)
    const result = publishGuideResponseSchema.parse(response.json())
    expect(result.created).toBe(true)
    expect(result.version).toMatchObject({
      version: 1,
      stepCount: 2,
      publishedBy: { userId: people.editor.userId, displayName: 'Acme Editor' },
    })
    expect(result.guide).toMatchObject({
      status: 'published',
      latestVersion: 1,
      hasUnpublishedChanges: false,
    })

    const v1 = await version(editor, workspace.id, guide.id, 1)
    expect(v1.snapshot).toEqual({
      version: 1,
      guide: {
        id: guide.id,
        applicationId: guide.applicationId,
        title: guide.title,
        description: '',
        startUrlPattern: null,
      },
      steps: guide.steps,
    })
  })

  it('keeps version 1 unchanged while the draft moves on to version 2', async () => {
    const { workspace, editor, guide } = await draftWithSteps()
    await publish(editor, workspace.id, guide.id)
    const v1Before = await version(editor, workspace.id, guide.id, 1)
    const [first, second] = guide.steps
    if (!first || !second) throw new Error('missing steps')

    // Edit the draft: rename the guide, change step 2, add step 3.
    await call(app, 'PATCH', guidePath(workspace.id, guide.id), editor, {
      title: 'Create a business customer',
    })
    const edited = await call(app, 'PUT', guidePath(workspace.id, guide.id, '/steps'), editor, {
      expectedRevision: 3,
      steps: [
        { id: first.id, title: first.title, body: first.body },
        { id: second.id, title: 'Click New business customer', body: body('Changed.') },
        { title: 'Fill in the company details', body: body('New step.') },
      ],
    })
    expect(edited.statusCode, edited.body).toBe(200)
    expect((await read(editor, workspace.id, guide.id)).hasUnpublishedChanges).toBe(true)

    const second_ = publishGuideResponseSchema.parse(
      (await publish(editor, workspace.id, guide.id)).json(),
    )
    expect(second_.version).toMatchObject({ version: 2, stepCount: 3 })

    const v1After = await version(editor, workspace.id, guide.id, 1)
    const v2 = await version(editor, workspace.id, guide.id, 2)
    expect(v1After).toEqual(v1Before)
    expect(v1After.snapshot.guide.title).toBe('Create a customer')
    expect(v1After.snapshot.steps.map((step) => step.title)).toEqual([
      'Open Customers',
      'Click New customer',
    ])
    expect(v2.snapshot.guide.title).toBe('Create a business customer')
    expect(v2.snapshot.steps.map((step) => step.title)).toEqual([
      'Open Customers',
      'Click New business customer',
      'Fill in the company details',
    ])

    // Even deleting every draft step leaves both snapshots intact.
    await call(app, 'PUT', guidePath(workspace.id, guide.id, '/steps'), editor, {
      expectedRevision: 4,
      steps: [],
    })
    expect(await version(editor, workspace.id, guide.id, 1)).toEqual(v1Before)
    expect((await version(editor, workspace.id, guide.id, 2)).snapshot).toEqual(v2.snapshot)

    const history = guideVersionListSchema.parse(
      (await call(app, 'GET', guidePath(workspace.id, guide.id, '/versions'), editor)).json(),
    )
    expect(history.items.map((item) => item.version)).toEqual([2, 1])
  })

  it('returns the latest version instead of a duplicate when nothing changed', async () => {
    const { workspace, editor, guide } = await draftWithSteps()
    await publish(editor, workspace.id, guide.id)

    const again = await publish(editor, workspace.id, guide.id)

    expect(again.statusCode).toBe(200)
    expect(publishGuideResponseSchema.parse(again.json())).toMatchObject({
      created: false,
      version: { version: 1 },
    })
  })

  it('creates exactly one version when several publishes race', async () => {
    const { workspace, editor, people, guide } = await draftWithSteps()
    await publish(editor, workspace.id, guide.id)
    await call(app, 'PATCH', guidePath(workspace.id, guide.id), editor, { title: 'Changed' })

    const responses = await Promise.all(
      [editor, people.admin.cookie, people.owner.cookie, editor, editor].map((cookie) =>
        publish(cookie, workspace.id, guide.id),
      ),
    )

    const results = responses.map((response) => publishGuideResponseSchema.parse(response.json()))
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 200, 200, 200, 201,
    ])
    expect(new Set(results.map((result) => result.version.version))).toEqual(new Set([2]))
    const history = guideVersionListSchema.parse(
      (await call(app, 'GET', guidePath(workspace.id, guide.id, '/versions'), editor)).json(),
    )
    expect(history.items.map((item) => item.version)).toEqual([2, 1])
  })

  it('never publishes a half-applied draft while steps are being replaced', async () => {
    const { workspace, editor, guide } = await draftWithSteps(['A', 'B'])
    const replacement = ['C', 'D', 'E']

    const [replaced, published] = await Promise.all([
      call(app, 'PUT', guidePath(workspace.id, guide.id, '/steps'), editor, {
        expectedRevision: guide.revision,
        steps: replacement.map((title) => ({ title, body: body(title) })),
      }),
      publish(editor, workspace.id, guide.id),
    ])

    expect(replaced.statusCode).toBe(200)
    const { version: summary } = publishGuideResponseSchema.parse(published.json())
    const snapshot = (await version(editor, workspace.id, guide.id, summary.version)).snapshot
    const titles = snapshot.steps.map((step) => step.title)
    // Either entirely before or entirely after the replacement.
    expect([['A', 'B'], replacement]).toContainEqual(titles)
  })

  it('refuses to publish a guide without steps, an archived guide, or for members', async () => {
    const { workspace, people, editor, guide } = await draftWithSteps([])

    const empty = await publish(editor, workspace.id, guide.id)
    expect(empty.statusCode).toBe(409)
    expect(apiErrorSchema.parse(empty.json()).error.message).toMatch(/at least one step/)

    expect((await publish(people.member.cookie, workspace.id, guide.id)).statusCode).toBe(403)

    await call(app, 'DELETE', guidePath(workspace.id, guide.id), editor)
    expect((await publish(editor, workspace.id, guide.id)).statusCode).toBe(409)
  })

  it('keeps versions readable after archiving and restores to published', async () => {
    const { workspace, editor, guide } = await draftWithSteps()
    await publish(editor, workspace.id, guide.id)

    await call(app, 'DELETE', guidePath(workspace.id, guide.id), editor)
    expect((await version(editor, workspace.id, guide.id, 1)).version).toBe(1)

    const restored = await call(app, 'POST', guidePath(workspace.id, guide.id, '/restore'), editor)
    expect(restored.json()).toMatchObject({ status: 'published', latestVersion: 1 })
  })

  it('answers 404 for unknown versions and 400 for malformed version numbers', async () => {
    const { workspace, editor, guide } = await draftWithSteps()
    await publish(editor, workspace.id, guide.id)

    expect(
      (await call(app, 'GET', guidePath(workspace.id, guide.id, '/versions/2'), editor)).statusCode,
    ).toBe(404)
    for (const bad of ['0', 'abc', '1.5', '-1']) {
      expect(
        (await call(app, 'GET', guidePath(workspace.id, guide.id, `/versions/${bad}`), editor))
          .statusCode,
      ).toBe(400)
    }
  })

  it('has no route that changes or deletes a published version', async () => {
    const { workspace, editor, guide } = await draftWithSteps()
    await publish(editor, workspace.id, guide.id)
    const url = guidePath(workspace.id, guide.id, '/versions/1')

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect((await call(app, method, url, editor, {})).statusCode).toBe(404)
    }
    expect((await version(editor, workspace.id, guide.id, 1)).version).toBe(1)
  })
})
