import { applicationListSchema, applicationSchema, apiErrorSchema } from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, register, type TestApp } from './support/app.js'
import { guides } from '../../src/infrastructure/database/schema.js'
import {
  call,
  createApplication,
  createWorkspace,
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

const path = (workspaceId: string, applicationId?: string) =>
  `/v1/workspaces/${workspaceId}/applications${applicationId ? `/${applicationId}` : ''}`

describe('applications', () => {
  it('creates, reads, updates and deletes an application', async () => {
    const { workspace, people } = await workspaceWithEveryRole(app)
    const cookie = people.admin.cookie

    const created = await createApplication(app, cookie, workspace.id, {
      name: '  Acme CRM ',
      origins: ['HTTPS://CRM.Acme.test/', 'https://crm.acme.test:8443'],
    })
    expect(created).toMatchObject({
      name: 'Acme CRM',
      origins: ['https://crm.acme.test', 'https://crm.acme.test:8443'],
    })

    const read = await call(app, 'GET', path(workspace.id, created.id), people.member.cookie)
    expect(applicationSchema.parse(read.json())).toEqual(created)

    const updated = await call(app, 'PATCH', path(workspace.id, created.id), cookie, {
      name: 'Acme Sales CRM',
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      name: 'Acme Sales CRM',
      origins: created.origins,
    })

    expect((await call(app, 'DELETE', path(workspace.id, created.id), cookie)).statusCode).toBe(204)
    expect((await call(app, 'GET', path(workspace.id, created.id), cookie)).statusCode).toBe(404)
  })

  it.each([
    ['a path', 'https://crm.acme.test/login'],
    ['a query string', 'https://crm.acme.test?tab=1'],
    ['a fragment', 'https://crm.acme.test#home'],
    ['a wildcard', '*.acme.test'],
    ['no scheme', 'crm.acme.test'],
    ['a javascript: URL', 'javascript:alert(1)'],
  ])('refuses an origin with %s', async (_, origin) => {
    const { workspace, people } = await workspaceWithEveryRole(app)

    const response = await call(app, 'POST', path(workspace.id), people.owner.cookie, {
      name: 'CRM',
      origins: [origin],
    })

    expect(response.statusCode).toBe(400)
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('VALIDATION_FAILED')
  })

  it('refuses duplicates, empty lists and unknown fields', async () => {
    const { workspace, people } = await workspaceWithEveryRole(app)
    const send = (payload: object) =>
      call(app, 'POST', path(workspace.id), people.owner.cookie, payload)

    expect(
      (await send({ name: 'CRM', origins: ['https://a.test', 'HTTPS://A.TEST/'] })).statusCode,
    ).toBe(400)
    expect((await send({ name: 'CRM', origins: [] })).statusCode).toBe(400)
    expect(
      (await send({ name: 'CRM', origins: ['https://a.test'], workspaceId: workspace.id }))
        .statusCode,
    ).toBe(400)
    expect((await send({ name: '', origins: ['https://a.test'] })).statusCode).toBe(400)
  })

  it('cannot be deleted while it has guides, so published history is kept', async () => {
    const { workspace, people } = await workspaceWithEveryRole(app)
    const application = await createApplication(app, people.owner.cookie, workspace.id)
    await database.db
      .insert(guides)
      .values({ workspaceId: workspace.id, applicationId: application.id, title: 'Onboarding' })

    const response = await call(
      app,
      'DELETE',
      path(workspace.id, application.id),
      people.owner.cookie,
    )

    expect(response.statusCode).toBe(409)
    expect(apiErrorSchema.parse(response.json()).error.message).toMatch(/has guides/)
  })
})

describe('application permissions', () => {
  it('lets any member read but only admins and owners manage', async () => {
    const { workspace, people } = await workspaceWithEveryRole(app)
    const application = await createApplication(app, people.owner.cookie, workspace.id)

    const statuses = async (cookie: string) => [
      (await call(app, 'GET', path(workspace.id), cookie)).statusCode,
      (await call(app, 'GET', path(workspace.id, application.id), cookie)).statusCode,
      (
        await call(app, 'POST', path(workspace.id), cookie, {
          name: 'ERP',
          origins: ['https://erp.acme.test'],
        })
      ).statusCode,
      (await call(app, 'PATCH', path(workspace.id, application.id), cookie, { name: 'CRM 2' }))
        .statusCode,
    ]

    expect(await statuses(people.owner.cookie)).toEqual([200, 200, 201, 200])
    expect(await statuses(people.admin.cookie)).toEqual([200, 200, 201, 200])
    expect(await statuses(people.editor.cookie)).toEqual([200, 200, 403, 403])
    expect(await statuses(people.member.cookie)).toEqual([200, 200, 403, 403])
    expect(
      (await call(app, 'DELETE', path(workspace.id, application.id), people.editor.cookie))
        .statusCode,
    ).toBe(403)
  })
})

describe('application pagination', () => {
  it('pages newest first without skipping or repeating, even while rows are added', async () => {
    const owner = await register(app, 'owner@acme.test')
    const workspace = await createWorkspace(app, owner.cookie, 'Acme')
    const created: string[] = []
    for (let index = 0; index < 5; index += 1) {
      created.push(
        (
          await createApplication(app, owner.cookie, workspace.id, {
            name: `App ${String(index)}`,
            origins: [`https://app${String(index)}.acme.test`],
          })
        ).id,
      )
    }

    const first = applicationListSchema.parse(
      (await call(app, 'GET', `${path(workspace.id)}?limit=2`, owner.cookie)).json(),
    )
    // A row created between pages lands before the cursor and does not shift later pages.
    await createApplication(app, owner.cookie, workspace.id, {
      name: 'Late',
      origins: ['https://late.acme.test'],
    })
    const second = applicationListSchema.parse(
      (
        await call(
          app,
          'GET',
          `${path(workspace.id)}?limit=2&cursor=${first.nextCursor ?? ''}`,
          owner.cookie,
        )
      ).json(),
    )
    const third = applicationListSchema.parse(
      (
        await call(
          app,
          'GET',
          `${path(workspace.id)}?limit=2&cursor=${second.nextCursor ?? ''}`,
          owner.cookie,
        )
      ).json(),
    )

    const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id)
    expect(seen).toEqual([...created].reverse())
    expect(third.nextCursor).toBeNull()
  })

  it.each([
    'not-a-cursor!',
    'eyJ2IjoyLCJpZCI6IngifQ',
    Buffer.from('{"v":1,"id":"x"}').toString('base64url'),
  ])('rejects the tampered cursor %s', async (cursor) => {
    const owner = await register(app, 'owner@acme.test')
    const workspace = await createWorkspace(app, owner.cookie, 'Acme')

    const response = await call(app, 'GET', `${path(workspace.id)}?cursor=${cursor}`, owner.cookie)

    expect(response.statusCode).toBe(400)
  })

  it('bounds the page size', async () => {
    const owner = await register(app, 'owner@acme.test')
    const workspace = await createWorkspace(app, owner.cookie, 'Acme')

    expect(
      (await call(app, 'GET', `${path(workspace.id)}?limit=101`, owner.cookie)).statusCode,
    ).toBe(400)
    expect((await call(app, 'GET', `${path(workspace.id)}?limit=0`, owner.cookie)).statusCode).toBe(
      400,
    )
  })
})
