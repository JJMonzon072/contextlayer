import {
  extensionAuthoringGuidePath,
  extensionAuthoringGuidesPath,
  extensionAuthoringStepsPath,
  guideListSchema,
  guideSchema,
  guideVersionSchema,
  type Guide,
} from '@contextlayer/shared'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, type TestApp } from './support/app.js'
import {
  body,
  call,
  createApplication,
  createGuide,
  targetDescriptor,
  workspaceWithEveryRole,
} from './support/content.js'
import { connect } from './support/extension.js'
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

type Method = 'GET' | 'POST' | 'PUT'

/** A bearer request from the extension's service worker, nothing else. */
function withToken(token: string, method: Method, url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  })
}

async function acme() {
  const { workspace, people } = await workspaceWithEveryRole(app, 'Acme')
  const crm = await createApplication(app, people.owner.cookie, workspace.id, {
    name: 'CRM',
    origins: [SHARED_ORIGIN],
  })
  const billing = await createApplication(app, people.owner.cookie, workspace.id, {
    name: 'Billing',
    origins: [SHARED_ORIGIN],
  })
  const tokens = {
    owner: (await connect(app, people.owner.cookie, workspace.id)).accessToken,
    editor: (await connect(app, people.editor.cookie, workspace.id)).accessToken,
    member: (await connect(app, people.member.cookie, workspace.id)).accessToken,
  }
  return { workspace, people, crm, billing, tokens }
}

const step = (title: string, extra: object = {}) => ({ title, body: body(`${title}.`), ...extra })

async function draft(token: string, applicationId: string, guideId: string): Promise<Guide> {
  const response = await withToken(
    token,
    'GET',
    extensionAuthoringGuidePath(applicationId, guideId),
  )
  expect(response.statusCode, response.body).toBe(200)
  return guideSchema.parse(response.json())
}

describe('guide authoring from the extension', () => {
  it('lets an editor list, create, read and replace the steps of a draft', async () => {
    const { workspace, people, crm, tokens } = await acme()
    const existing = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'Existing')

    const created = await withToken(tokens.editor, 'POST', extensionAuthoringGuidesPath(crm.id), {
      title: 'Create a customer',
    })
    expect(created.statusCode, created.body).toBe(201)
    const guide = guideSchema.parse(created.json())
    expect(guide).toMatchObject({ applicationId: crm.id, status: 'draft', revision: 1 })

    const listed = await withToken(tokens.editor, 'GET', extensionAuthoringGuidesPath(crm.id))
    expect(listed.statusCode).toBe(200)
    expect(
      guideListSchema
        .parse(listed.json())
        .items.map((item) => item.id)
        .sort(),
    ).toEqual([existing.id, guide.id].sort())

    const target = targetDescriptor()
    const saved = await withToken(
      tokens.editor,
      'PUT',
      extensionAuthoringStepsPath(crm.id, guide.id),
      {
        expectedRevision: 1,
        steps: [step('Open Customers', { target }), step('Click New'), step('Save')],
      },
    )
    expect(saved.statusCode, saved.body).toBe(200)
    const after = guideSchema.parse(saved.json())
    expect(after.revision).toBe(2)
    expect(after.steps.map((item) => item.title)).toEqual(['Open Customers', 'Click New', 'Save'])
    expect(after.steps[0]?.target).toEqual(target)

    // The dashboard sees exactly what the extension saved.
    const dashboard = await call(
      app,
      'GET',
      `/v1/workspaces/${workspace.id}/guides/${guide.id}`,
      people.owner.cookie,
    )
    expect(guideSchema.parse(dashboard.json()).steps).toEqual(after.steps)
  })

  it('keeps step ids across a reorder and refuses a stale revision without changing anything', async () => {
    const { crm, tokens } = await acme()
    const created = guideSchema.parse(
      (
        await withToken(tokens.owner, 'POST', extensionAuthoringGuidesPath(crm.id), {
          title: 'Guide',
        })
      ).json(),
    )
    const path = extensionAuthoringStepsPath(crm.id, created.id)
    const first = guideSchema.parse(
      (
        await withToken(tokens.owner, 'PUT', path, {
          expectedRevision: 1,
          steps: [step('One'), step('Two')],
        })
      ).json(),
    )
    const [one, two] = first.steps
    if (!one || !two) throw new Error('missing steps')

    const reordered = guideSchema.parse(
      (
        await withToken(tokens.owner, 'PUT', path, {
          expectedRevision: 2,
          steps: [
            { id: two.id, title: two.title, body: two.body },
            { id: one.id, title: one.title, body: one.body },
          ],
        })
      ).json(),
    )
    expect(reordered.steps.map((item) => item.id)).toEqual([two.id, one.id])

    const stale = await withToken(tokens.owner, 'PUT', path, {
      expectedRevision: 2,
      steps: [step('Lost update')],
    })
    expect(stale.statusCode).toBe(409)
    expect((await draft(tokens.owner, crm.id, created.id)).steps.map((item) => item.id)).toEqual([
      two.id,
      one.id,
    ])
  })

  it('refuses members: no drafts to read, nothing to write', async () => {
    const { workspace, people, crm, tokens } = await acme()
    const guide = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'Draft')

    for (const [method, url, payload] of [
      ['GET', extensionAuthoringGuidesPath(crm.id), undefined],
      ['POST', extensionAuthoringGuidesPath(crm.id), { title: 'Mine' }],
      ['GET', extensionAuthoringGuidePath(crm.id, guide.id), undefined],
      [
        'PUT',
        extensionAuthoringStepsPath(crm.id, guide.id),
        { expectedRevision: 1, steps: [step('Mine')] },
      ],
    ] as const) {
      const response = await withToken(tokens.member, method, url, payload)
      expect(response.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it('checks the role on every request: a demoted editor is refused at once', async () => {
    const { workspace, people, crm, tokens } = await acme()
    expect(
      (await withToken(tokens.editor, 'GET', extensionAuthoringGuidesPath(crm.id))).statusCode,
    ).toBe(200)

    const demoted = await call(
      app,
      'PATCH',
      `/v1/workspaces/${workspace.id}/members/${people.editor.userId}`,
      people.owner.cookie,
      { role: 'member' },
    )
    expect(demoted.statusCode, demoted.body).toBe(200)

    expect(
      (await withToken(tokens.editor, 'GET', extensionAuthoringGuidesPath(crm.id))).statusCode,
    ).toBe(403)
  })

  it('refuses a missing, invalid or revoked token, and never falls back to the cookie', async () => {
    const { people, crm, tokens } = await acme()
    const url = extensionAuthoringGuidesPath(crm.id)

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { cookie: people.owner.cookie },
        })
      ).statusCode,
    ).toBe(401)
    expect((await withToken(`cla_${'A'.repeat(43)}`, 'GET', url)).statusCode).toBe(401)
    // An invalid body does not hide a missing token: authentication runs first.
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: extensionAuthoringStepsPath(crm.id, crypto.randomUUID()),
          payload: { nonsense: true },
        })
      ).statusCode,
    ).toBe(401)

    const connections = await call(app, 'GET', '/v1/extension/connections', people.owner.cookie)
    const [ownerConnection] = connections.json<{ items: { id: string }[] }>().items
    if (!ownerConnection) throw new Error('missing connection')
    await call(
      app,
      'DELETE',
      `/v1/extension/connections/${ownerConnection.id}`,
      people.owner.cookie,
    )
    expect((await withToken(tokens.owner, 'GET', url)).statusCode).toBe(401)
  })

  it('keeps tenants apart even when they register the same origin', async () => {
    const acmeSide = await acme()
    const globex = await workspaceWithEveryRole(app, 'Globex')
    const globexCrm = await createApplication(
      app,
      globex.people.owner.cookie,
      globex.workspace.id,
      { name: 'CRM', origins: [SHARED_ORIGIN] },
    )
    const globexGuide = await createGuide(
      app,
      globex.people.owner.cookie,
      globex.workspace.id,
      globexCrm.id,
      'Globex only',
    )

    // Acme's editor, through Acme's grant: Globex's application and guide do not exist.
    const token = acmeSide.tokens.editor
    expect(
      (await withToken(token, 'GET', extensionAuthoringGuidesPath(globexCrm.id))).statusCode,
    ).toBe(404)
    expect(
      (await withToken(token, 'GET', extensionAuthoringGuidePath(globexCrm.id, globexGuide.id)))
        .statusCode,
    ).toBe(404)
    expect(
      (await withToken(token, 'GET', extensionAuthoringGuidePath(acmeSide.crm.id, globexGuide.id)))
        .statusCode,
    ).toBe(404)
    expect(
      (
        await withToken(
          token,
          'PUT',
          extensionAuthoringStepsPath(acmeSide.crm.id, globexGuide.id),
          {
            expectedRevision: 1,
            steps: [step('Takeover')],
          },
        )
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await withToken(token, 'POST', extensionAuthoringGuidesPath(globexCrm.id), {
          title: 'Into Globex',
        })
      ).statusCode,
    ).toBe(404)
  })

  it('refuses a guide under another application of the same workspace', async () => {
    const { workspace, people, crm, billing, tokens } = await acme()
    const guide = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'CRM guide')

    expect(
      (await withToken(tokens.editor, 'GET', extensionAuthoringGuidePath(billing.id, guide.id)))
        .statusCode,
    ).toBe(404)
    expect(
      (
        await withToken(tokens.editor, 'PUT', extensionAuthoringStepsPath(billing.id, guide.id), {
          expectedRevision: 1,
          steps: [step('Wrong application')],
        })
      ).statusCode,
    ).toBe(404)
    expect((await draft(tokens.editor, crm.id, guide.id)).steps).toEqual([])
  })

  it('refuses step ids of another guide and leaves both guides untouched', async () => {
    const { workspace, people, crm, tokens } = await acme()
    const a = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'A')
    const b = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'B')
    const bSaved = guideSchema.parse(
      (
        await withToken(tokens.editor, 'PUT', extensionAuthoringStepsPath(crm.id, b.id), {
          expectedRevision: 1,
          steps: [step('B one')],
        })
      ).json(),
    )
    const foreign = bSaved.steps[0]
    if (!foreign) throw new Error('missing step')

    const response = await withToken(
      tokens.editor,
      'PUT',
      extensionAuthoringStepsPath(crm.id, a.id),
      {
        expectedRevision: 1,
        steps: [{ id: foreign.id, title: 'Stolen', body: foreign.body }],
      },
    )

    expect(response.statusCode).toBe(404)
    expect((await draft(tokens.editor, crm.id, a.id)).steps).toEqual([])
    expect((await draft(tokens.editor, crm.id, b.id)).steps.map((item) => item.title)).toEqual([
      'B one',
    ])
  })

  it('treats an archived guide as not editable', async () => {
    const { workspace, people, crm, tokens } = await acme()
    const guide = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'Old')
    await call(
      app,
      'DELETE',
      `/v1/workspaces/${workspace.id}/guides/${guide.id}`,
      people.owner.cookie,
    )

    expect(
      (await withToken(tokens.editor, 'GET', extensionAuthoringGuidePath(crm.id, guide.id)))
        .statusCode,
    ).toBe(409)
    expect(
      (
        await withToken(tokens.editor, 'PUT', extensionAuthoringStepsPath(crm.id, guide.id), {
          expectedRevision: 2,
          steps: [step('Too late')],
        })
      ).statusCode,
    ).toBe(409)
    const listed = guideListSchema.parse(
      (await withToken(tokens.editor, 'GET', extensionAuthoringGuidesPath(crm.id))).json(),
    )
    expect(listed.items.map((item) => item.id)).not.toContain(guide.id)
  })

  it('rejects an invalid target descriptor and rolls back a replacement that fails midway', async () => {
    const { workspace, people, crm, tokens } = await acme()
    const guide = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'Guide')
    const path = extensionAuthoringStepsPath(crm.id, guide.id)
    const saved = guideSchema.parse(
      (
        await withToken(tokens.editor, 'PUT', path, {
          expectedRevision: 1,
          steps: [step('One'), step('Two')],
        })
      ).json(),
    )

    const invalid = await withToken(tokens.editor, 'PUT', path, {
      expectedRevision: 2,
      steps: [step('Bad', { target: { ...targetDescriptor(), html: '<button>' } })],
    })
    expect(invalid.statusCode).toBe(400)

    await database.db.execute(sql`
      create function fail_marked_step() returns trigger language plpgsql as $$
      begin
        if new.title = 'FAIL_ME' then raise exception 'forced failure'; end if;
        return new;
      end $$`)
    await database.db.execute(
      sql`create trigger fail_marked_step before insert on guide_steps for each row execute function fail_marked_step()`,
    )
    try {
      const failed = await withToken(tokens.editor, 'PUT', path, {
        expectedRevision: 2,
        steps: [
          { id: saved.steps[1]?.id, title: 'Two moved', body: body('Moved.') },
          step('FAIL_ME'),
        ],
      })
      expect(failed.statusCode).toBe(500)
    } finally {
      await database.db.execute(sql`drop trigger fail_marked_step on guide_steps`)
      await database.db.execute(sql`drop function fail_marked_step()`)
    }

    const after = await draft(tokens.editor, crm.id, guide.id)
    expect(after.revision).toBe(2)
    expect(after.steps.map((item) => item.title)).toEqual(['One', 'Two'])
  })

  it('never touches a published version', async () => {
    const { workspace, people, crm, tokens } = await acme()
    const guide = await createGuide(app, people.owner.cookie, workspace.id, crm.id, 'Guide')
    const base = `/v1/workspaces/${workspace.id}/guides/${guide.id}`
    await call(app, 'PUT', `${base}/steps`, people.owner.cookie, {
      expectedRevision: 1,
      steps: [step('Published step')],
    })
    expect((await call(app, 'POST', `${base}/publish`, people.owner.cookie)).statusCode).toBe(201)
    const before = guideVersionSchema.parse(
      (await call(app, 'GET', `${base}/versions/1`, people.owner.cookie)).json(),
    )

    const changed = await withToken(
      tokens.editor,
      'PUT',
      extensionAuthoringStepsPath(crm.id, guide.id),
      {
        expectedRevision: 2,
        steps: [step('Draft step', { target: targetDescriptor() })],
      },
    )
    expect(changed.statusCode, changed.body).toBe(200)

    const after = guideVersionSchema.parse(
      (await call(app, 'GET', `${base}/versions/1`, people.owner.cookie)).json(),
    )
    expect(after).toEqual(before)
    expect((await draft(tokens.editor, crm.id, guide.id)).hasUnpublishedChanges).toBe(true)
  })
})
