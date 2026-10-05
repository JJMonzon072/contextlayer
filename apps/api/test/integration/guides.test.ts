import { apiErrorSchema, guideListSchema, guideSchema } from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, type TestApp } from './support/app.js'
import { call, createApplication, createGuide, workspaceWithEveryRole } from './support/content.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp

afterAll(() => database.close())
beforeEach(async () => {
  await resetTestDatabase(database)
  app = await buildTestApp()
})
afterEach(() => app.close())

const guidesPath = (workspaceId: string, guideId?: string, action?: string) =>
  `/v1/workspaces/${workspaceId}/guides${guideId ? `/${guideId}` : ''}${action ? `/${action}` : ''}`

async function setup() {
  const { workspace, people } = await workspaceWithEveryRole(app)
  const application = await createApplication(app, people.owner.cookie, workspace.id)
  return { workspace, people, application, editor: people.editor.cookie }
}

describe('guide drafts', () => {
  it('creates a draft in an application and reads it back', async () => {
    const { workspace, application, editor } = await setup()

    const response = await call(app, 'POST', guidesPath(workspace.id), editor, {
      applicationId: application.id,
      title: '  Create a customer ',
      description: 'From the Customers page.',
      startUrlPattern: { pathname: '/customers' },
    })

    expect(response.statusCode).toBe(201)
    const guide = guideSchema.parse(response.json())
    expect(guide).toMatchObject({
      applicationId: application.id,
      title: 'Create a customer',
      description: 'From the Customers page.',
      status: 'draft',
      revision: 1,
      stepCount: 0,
      latestVersion: null,
      hasUnpublishedChanges: true,
      startUrlPattern: { pathname: '/customers' },
      steps: [],
      archivedAt: null,
    })
    const read = await call(app, 'GET', guidesPath(workspace.id, guide.id), editor)
    expect(guideSchema.parse(read.json())).toEqual(guide)
  })

  it('updates metadata and moves to the next revision', async () => {
    const { workspace, application, editor } = await setup()
    const guide = await createGuide(app, editor, workspace.id, application.id)

    const response = await call(app, 'PATCH', guidesPath(workspace.id, guide.id), editor, {
      title: 'Create a business customer',
      startUrlPattern: null,
      expectedRevision: 1,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      title: 'Create a business customer',
      revision: 2,
      startUrlPattern: null,
    })
  })

  it('refuses an update based on an older revision (lost update)', async () => {
    const { workspace, application, editor } = await setup()
    const guide = await createGuide(app, editor, workspace.id, application.id)
    await call(app, 'PATCH', guidesPath(workspace.id, guide.id), editor, { title: 'First tab' })

    const stale = await call(app, 'PATCH', guidesPath(workspace.id, guide.id), editor, {
      title: 'Second tab',
      expectedRevision: 1,
    })

    expect(stale.statusCode).toBe(409)
    expect(apiErrorSchema.parse(stale.json()).error.message).toMatch(/changed by someone else/)
  })

  it('validates input and refuses fields the client may not set', async () => {
    const { workspace, application, editor } = await setup()
    const create = (payload: object) => call(app, 'POST', guidesPath(workspace.id), editor, payload)

    expect((await create({ applicationId: application.id, title: '' })).statusCode).toBe(400)
    expect(
      (await create({ applicationId: application.id, title: 'x'.repeat(121) })).statusCode,
    ).toBe(400)
    expect(
      (await create({ applicationId: application.id, title: 'T', status: 'published' })).statusCode,
    ).toBe(400)
    expect(
      (
        await create({
          applicationId: application.id,
          title: 'T',
          startUrlPattern: { pathname: '/a b' },
        })
      ).statusCode,
    ).toBe(400)
    expect((await create({ applicationId: 'not-a-uuid', title: 'T' })).statusCode).toBe(400)
  })

  it('answers 404 for an application that is not in the workspace', async () => {
    const { workspace, editor } = await setup()
    const other = await workspaceWithEveryRole(app, 'Globex')
    const foreignApplication = await createApplication(
      app,
      other.people.owner.cookie,
      other.workspace.id,
    )

    const response = await call(app, 'POST', guidesPath(workspace.id), editor, {
      applicationId: foreignApplication.id,
      title: 'Borrowed application',
    })

    expect(response.statusCode).toBe(404)
    expect(apiErrorSchema.parse(response.json()).error.message).toBe('Application not found.')
  })

  it('archives instead of deleting, hides archived guides by default and restores them', async () => {
    const { workspace, application, editor } = await setup()
    const guide = await createGuide(app, editor, workspace.id, application.id)

    expect((await call(app, 'DELETE', guidesPath(workspace.id, guide.id), editor)).statusCode).toBe(
      204,
    )
    const archived = guideSchema.parse(
      (await call(app, 'GET', guidesPath(workspace.id, guide.id), editor)).json(),
    )
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).not.toBeNull()
    expect(
      (await call(app, 'PATCH', guidesPath(workspace.id, guide.id), editor, { title: 'X' }))
        .statusCode,
    ).toBe(409)

    const active = guideListSchema.parse(
      (await call(app, 'GET', guidesPath(workspace.id), editor)).json(),
    )
    const archivedOnly = guideListSchema.parse(
      (await call(app, 'GET', `${guidesPath(workspace.id)}?status=archived`, editor)).json(),
    )
    expect(active.items).toEqual([])
    expect(archivedOnly.items.map((item) => item.id)).toEqual([guide.id])

    const restored = await call(app, 'POST', guidesPath(workspace.id, guide.id, 'restore'), editor)
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toMatchObject({ status: 'draft', archivedAt: null })
  })

  it('lists guides per application, newest first, with cursors', async () => {
    const { workspace, application, people, editor } = await setup()
    const erp = await createApplication(app, people.owner.cookie, workspace.id, {
      name: 'ERP',
      origins: ['https://erp.acme.test'],
    })
    const crmGuides = []
    for (const title of ['One', 'Two', 'Three']) {
      crmGuides.push(await createGuide(app, editor, workspace.id, application.id, title))
    }
    await createGuide(app, editor, workspace.id, erp.id, 'ERP guide')

    const first = guideListSchema.parse(
      (
        await call(
          app,
          'GET',
          `${guidesPath(workspace.id)}?applicationId=${application.id}&limit=2`,
          editor,
        )
      ).json(),
    )
    const second = guideListSchema.parse(
      (
        await call(
          app,
          'GET',
          `${guidesPath(workspace.id)}?applicationId=${application.id}&limit=2&cursor=${first.nextCursor ?? ''}`,
          editor,
        )
      ).json(),
    )

    expect([...first.items, ...second.items].map((item) => item.title)).toEqual([
      'Three',
      'Two',
      'One',
    ])
    expect(second.nextCursor).toBeNull()
    const all = guideListSchema.parse(
      (await call(app, 'GET', guidesPath(workspace.id), editor)).json(),
    )
    expect(all.items).toHaveLength(4)
  })

  it('rejects tampered cursors and unknown filter values', async () => {
    const { workspace, editor } = await setup()

    expect(
      (await call(app, 'GET', `${guidesPath(workspace.id)}?cursor=AAAA`, editor)).statusCode,
    ).toBe(400)
    expect(
      (await call(app, 'GET', `${guidesPath(workspace.id)}?status=deleted`, editor)).statusCode,
    ).toBe(400)
  })
})

describe('guide permissions', () => {
  it('lets editors, admins and owners author, and refuses members', async () => {
    const { workspace, people, application } = await setup()
    const guide = await createGuide(app, people.editor.cookie, workspace.id, application.id)

    const statuses = async (cookie: string) => [
      (await call(app, 'GET', guidesPath(workspace.id), cookie)).statusCode,
      (await call(app, 'GET', guidesPath(workspace.id, guide.id), cookie)).statusCode,
      (
        await call(app, 'POST', guidesPath(workspace.id), cookie, {
          applicationId: application.id,
          title: 'New',
        })
      ).statusCode,
      (await call(app, 'PATCH', guidesPath(workspace.id, guide.id), cookie, { title: 'Renamed' }))
        .statusCode,
    ]

    expect(await statuses(people.owner.cookie)).toEqual([200, 200, 201, 200])
    expect(await statuses(people.admin.cookie)).toEqual([200, 200, 201, 200])
    expect(await statuses(people.editor.cookie)).toEqual([200, 200, 201, 200])
    expect(await statuses(people.member.cookie)).toEqual([403, 403, 403, 403])
  })
})
