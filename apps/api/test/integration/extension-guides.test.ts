import {
  extensionApplicationListSchema,
  publishedGuideListSchema,
  publishedGuideSchema,
} from '@contextlayer/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, register, type TestApp } from './support/app.js'
import {
  body,
  call,
  createApplication,
  createGuide,
  workspaceWithEveryRole,
} from './support/content.js'
import { bearer, connect } from './support/extension.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp

afterAll(() => database.close())
beforeEach(async () => {
  await resetTestDatabase(database)
  app = await buildTestApp()
})
afterEach(() => app.close())

const SHARED_ORIGIN = 'https://crm.shared.test'

/** A guide with steps, optionally published. */
async function guide(
  editor: string,
  workspaceId: string,
  applicationId: string,
  title: string,
  options: { publish: boolean },
) {
  const created = await createGuide(app, editor, workspaceId, applicationId, title)
  const base = `/v1/workspaces/${workspaceId}/guides/${created.id}`
  await call(app, 'PUT', `${base}/steps`, editor, {
    expectedRevision: 1,
    steps: [
      { title: 'Open Customers', body: body('Open Customers.') },
      { title: 'Click New', body: body('Click New.') },
    ],
  })
  if (options.publish)
    expect((await call(app, 'POST', `${base}/publish`, editor)).statusCode).toBe(201)
  return { id: created.id, base }
}

/** Workspace A (Acme) and B (Globex) both register the same origin. */
async function tenants() {
  const a = await workspaceWithEveryRole(app, 'Acme')
  const b = await workspaceWithEveryRole(app, 'Globex')
  const appA = await createApplication(app, a.people.owner.cookie, a.workspace.id, {
    name: 'CRM',
    origins: [SHARED_ORIGIN, 'https://crm.acme.test:8443'],
  })
  const appB = await createApplication(app, b.people.owner.cookie, b.workspace.id, {
    name: 'CRM',
    origins: [SHARED_ORIGIN],
  })
  const editorA = a.people.editor.cookie
  const published = await guide(editorA, a.workspace.id, appA.id, 'Create a customer', {
    publish: true,
  })
  const draft = await guide(editorA, a.workspace.id, appA.id, 'Never published', { publish: false })
  const archived = await guide(editorA, a.workspace.id, appA.id, 'Archived guide', {
    publish: true,
  })
  await call(app, 'DELETE', archived.base, editorA)
  const foreign = await guide(b.people.editor.cookie, b.workspace.id, appB.id, 'Globex guide', {
    publish: true,
  })
  // A member (learner) of A connects the extension.
  const tokens = await connect(app, a.people.member.cookie, a.workspace.id)
  return { a, b, appA, appB, published, draft, archived, foreign, tokens }
}

const guides = (token: string, query: string) => bearer(app, `/v1/extension/guides?${query}`, token)

describe('published guides for an extension connection', () => {
  it('lists only published, non-archived guides of the grant workspace, as light summaries', async () => {
    const { tokens, published, appA } = await tenants()

    const response = await guides(tokens.accessToken, `origin=${encodeURIComponent(SHARED_ORIGIN)}`)

    expect(response.statusCode).toBe(200)
    const list = publishedGuideListSchema.parse(response.json())
    expect(list.items).toEqual([
      expect.objectContaining({
        guideId: published.id,
        applicationId: appA.id,
        version: 1,
        title: 'Create a customer',
        stepCount: 2,
      }),
    ])
    expect(Object.keys(list.items[0] ?? {})).not.toContain('snapshot')
    expect(response.body).not.toMatch(/publishedBy|email|editor@/)
  })

  it('carries the start page of the published version, never the draft one', async () => {
    const { a, tokens, published } = await tenants()
    const editor = a.people.editor.cookie
    const start = { protocol: 'https', hostname: 'crm.shared.test', pathname: '/customers' }
    await call(app, 'PATCH', published.base, editor, { startUrlPattern: start })
    expect((await call(app, 'POST', `${published.base}/publish`, editor)).statusCode).toBe(201)
    // A later draft edit is not what learners get.
    await call(app, 'PATCH', published.base, editor, { startUrlPattern: { pathname: '/draft' } })

    const list = publishedGuideListSchema.parse(
      (await guides(tokens.accessToken, `origin=${encodeURIComponent(SHARED_ORIGIN)}`)).json(),
    )

    expect(list.items).toEqual([
      expect.objectContaining({ guideId: published.id, version: 2, startUrlPattern: start }),
    ])
  })

  it('reports no start page as null: the guide starts on any page of the origin', async () => {
    const { tokens } = await tenants()

    const list = publishedGuideListSchema.parse(
      (await guides(tokens.accessToken, `origin=${encodeURIComponent(SHARED_ORIGIN)}`)).json(),
    )

    expect(list.items[0]?.startUrlPattern).toBeNull()
  })

  it('serves the published snapshot even after the draft changes', async () => {
    const { tokens, published, a } = await tenants()
    await call(app, 'PATCH', published.base, a.people.editor.cookie, { title: 'Draft rename' })

    const list = publishedGuideListSchema.parse(
      (await guides(tokens.accessToken, `origin=${encodeURIComponent(SHARED_ORIGIN)}`)).json(),
    )
    const detail = publishedGuideSchema.parse(
      (await bearer(app, `/v1/extension/guides/${published.id}`, tokens.accessToken)).json(),
    )

    expect(list.items[0]?.title).toBe('Create a customer')
    expect(detail.snapshot.guide.title).toBe('Create a customer')
    expect(detail.snapshot.steps.map((step) => step.title)).toEqual(['Open Customers', 'Click New'])
  })

  it('matches exact origins only, normalized like application origins', async () => {
    const { tokens } = await tenants()
    const count = async (origin: string) =>
      publishedGuideListSchema.parse(
        (await guides(tokens.accessToken, `origin=${encodeURIComponent(origin)}`)).json(),
      ).items.length

    expect(await count('HTTPS://CRM.Shared.test:443/')).toBe(1)
    expect(await count('https://crm.acme.test:8443')).toBe(1)
    expect(await count('https://crm.acme.test')).toBe(0)
    expect(await count('https://crm.shared.test.evil.example')).toBe(0)
    expect(
      (
        await guides(
          tokens.accessToken,
          `origin=${encodeURIComponent(`${SHARED_ORIGIN}/customers?id=7`)}`,
        )
      ).statusCode,
    ).toBe(400)
  })

  it('keeps tenants apart even when they register the same origin', async () => {
    const { tokens, foreign, b } = await tenants()
    const tokensB = await connect(app, b.people.member.cookie, b.workspace.id)

    const listA = publishedGuideListSchema.parse(
      (await guides(tokens.accessToken, `origin=${encodeURIComponent(SHARED_ORIGIN)}`)).json(),
    )
    const listB = publishedGuideListSchema.parse(
      (await guides(tokensB.accessToken, `origin=${encodeURIComponent(SHARED_ORIGIN)}`)).json(),
    )

    expect(listA.items.map((item) => item.title)).toEqual(['Create a customer'])
    expect(listB.items.map((item) => item.title)).toEqual(['Globex guide'])
    expect(
      (await bearer(app, `/v1/extension/guides/${foreign.id}`, tokens.accessToken)).statusCode,
    ).toBe(404)
  })

  it('answers 404 for drafts, archived guides and unknown ids', async () => {
    const { tokens, draft, archived } = await tenants()

    for (const id of [draft.id, archived.id, '01a10a2e-864b-75bc-8800-aa3f01a05399']) {
      expect((await bearer(app, `/v1/extension/guides/${id}`, tokens.accessToken)).statusCode).toBe(
        404,
      )
    }
  })

  it('bounds the page size and paginates with opaque cursors', async () => {
    const { tokens, a, appA } = await tenants()
    await guide(a.people.editor.cookie, a.workspace.id, appA.id, 'Second', { publish: true })
    const origin = encodeURIComponent(SHARED_ORIGIN)

    const first = publishedGuideListSchema.parse(
      (await guides(tokens.accessToken, `origin=${origin}&limit=1`)).json(),
    )
    const second = publishedGuideListSchema.parse(
      (
        await guides(
          tokens.accessToken,
          `origin=${origin}&limit=1&cursor=${first.nextCursor ?? ''}`,
        )
      ).json(),
    )

    expect([...first.items, ...second.items].map((item) => item.title)).toEqual([
      'Second',
      'Create a customer',
    ])
    expect(second.nextCursor).toBeNull()
    expect((await guides(tokens.accessToken, `origin=${origin}&limit=101`)).statusCode).toBe(400)
    expect((await guides(tokens.accessToken, `origin=${origin}&cursor=nope!`)).statusCode).toBe(400)
  })

  it('lists the applications of the grant workspace only', async () => {
    const { tokens, appA } = await tenants()

    const { items } = extensionApplicationListSchema.parse(
      (await bearer(app, '/v1/extension/applications', tokens.accessToken)).json(),
    )

    expect(items).toEqual([{ id: appA.id, name: 'CRM', origins: appA.origins }])
  })

  it('gives a member reading rights only: authoring routes refuse extension tokens', async () => {
    const { tokens, a, published } = await tenants()

    const authoring = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${a.workspace.id}/guides/${published.id}`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    })

    expect(authoring.statusCode).toBe(401)
  })

  it('needs a live access token', async () => {
    const { tokens } = await tenants()
    const outsider = await register(app, 'outsider@example.test')

    expect(
      (await bearer(app, '/v1/extension/applications', `cla_${'A'.repeat(43)}`)).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/extension/guides?origin=${encodeURIComponent(SHARED_ORIGIN)}`,
          headers: { cookie: outsider.cookie },
        })
      ).statusCode,
    ).toBe(401)
    await bearer(app, '/v1/extension/revoke', tokens.accessToken, 'POST')
    expect((await bearer(app, '/v1/extension/applications', tokens.accessToken)).statusCode).toBe(
      401,
    )
  })
})
