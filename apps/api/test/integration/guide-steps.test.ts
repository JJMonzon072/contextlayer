import { apiErrorSchema, guideSchema, type Guide } from '@contextlayer/shared'
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
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

const database = connectTestDatabase()
let app: TestApp

afterAll(() => database.close())
beforeEach(async () => {
  await resetTestDatabase(database)
  app = await buildTestApp()
})
afterEach(() => app.close())

const stepsPath = (workspaceId: string, guideId: string) =>
  `/v1/workspaces/${workspaceId}/guides/${guideId}/steps`
const guidePath = (workspaceId: string, guideId: string) =>
  `/v1/workspaces/${workspaceId}/guides/${guideId}`

async function setup() {
  const { workspace, people } = await workspaceWithEveryRole(app)
  const application = await createApplication(app, people.owner.cookie, workspace.id)
  const editor = people.editor.cookie
  const guide = await createGuide(app, editor, workspace.id, application.id)
  return { workspace, people, application, editor, guide }
}

async function replace(
  cookie: string,
  workspaceId: string,
  guideId: string,
  expectedRevision: number,
  steps: object[],
) {
  return call(app, 'PUT', stepsPath(workspaceId, guideId), cookie, { expectedRevision, steps })
}

async function read(cookie: string, workspaceId: string, guideId: string): Promise<Guide> {
  return guideSchema.parse((await call(app, 'GET', guidePath(workspaceId, guideId), cookie)).json())
}

const titles = (guide: Guide) => guide.steps.map((step) => step.title)

/** A guide with steps One, Two, Three at positions 0, 1, 2 (revision 2). */
async function withThreeSteps() {
  const context = await setup()
  const response = await replace(context.editor, context.workspace.id, context.guide.id, 1, [
    { title: 'One', body: body('Open Customers.') },
    { title: 'Two', body: body('Click New customer.') },
    { title: 'Three', body: body('Fill in the details.') },
  ])
  expect(response.statusCode, response.body).toBe(200)
  return { ...context, draft: guideSchema.parse(response.json()) }
}

describe('replacing the ordered steps', () => {
  it('stores the list in order with contiguous positions and a new revision', async () => {
    const { draft } = await withThreeSteps()

    expect(titles(draft)).toEqual(['One', 'Two', 'Three'])
    expect(draft.steps.map((step) => step.position)).toEqual([0, 1, 2])
    expect(draft.steps.every((step) => step.target === null && step.placement === 'auto')).toBe(
      true,
    )
    expect(draft).toMatchObject({ revision: 2, stepCount: 3 })
  })

  it('reorders and edits while keeping step ids', async () => {
    const { workspace, editor, guide, draft } = await withThreeSteps()
    const [one, two, three] = draft.steps
    if (!one || !two || !three) throw new Error('missing steps')

    const response = await replace(editor, workspace.id, guide.id, 2, [
      { id: three.id, title: three.title, body: three.body },
      { id: one.id, title: 'One, renamed', body: one.body, placement: 'bottom' },
      { id: two.id, title: two.title, body: two.body },
    ])

    const reordered = guideSchema.parse(response.json())
    expect(titles(reordered)).toEqual(['Three', 'One, renamed', 'Two'])
    expect(reordered.steps.map((step) => step.id)).toEqual([three.id, one.id, two.id])
    expect(reordered.steps[1]?.placement).toBe('bottom')
    expect(reordered.revision).toBe(3)
  })

  it('removes steps left out and inserts new ones', async () => {
    const { workspace, editor, guide, draft } = await withThreeSteps()
    const two = draft.steps[1]
    if (!two) throw new Error('missing step')

    const response = await replace(editor, workspace.id, guide.id, 2, [
      { title: 'Zero', body: body('Sign in.') },
      { id: two.id, title: two.title, body: two.body },
    ])

    const updated = guideSchema.parse(response.json())
    expect(titles(updated)).toEqual(['Zero', 'Two'])
    expect(updated.steps[1]?.id).toBe(two.id)
    expect(updated.steps.map((step) => step.position)).toEqual([0, 1])
  })

  it('stores and returns a target descriptor and URL pattern unchanged', async () => {
    const { workspace, editor, guide } = await setup()
    const target = targetDescriptor()

    const response = await replace(editor, workspace.id, guide.id, 1, [
      {
        title: 'New customer',
        body: body('Click it.'),
        target,
        urlPattern: { pathname: '/customers' },
      },
    ])

    const step = guideSchema.parse(response.json()).steps[0]
    expect(step?.target).toEqual(target)
    expect(step?.urlPattern).toEqual({ pathname: '/customers' })
  })

  it('rolls back the whole replacement when a write fails midway', async () => {
    const { workspace, editor, guide, draft } = await withThreeSteps()
    const [one, two, three] = draft.steps
    if (!one || !two || !three) throw new Error('missing steps')
    // Test-only trigger: the insert of a step titled FAIL_ME fails after the
    // delete and the updates of the same transaction have already run.
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
      const response = await replace(editor, workspace.id, guide.id, 2, [
        { id: three.id, title: 'Three moved first', body: three.body },
        { id: one.id, title: one.title, body: one.body },
        { title: 'FAIL_ME', body: body('Never stored.') },
      ])
      expect(response.statusCode).toBe(500)
    } finally {
      await database.db.execute(sql`drop trigger fail_marked_step on guide_steps`)
      await database.db.execute(sql`drop function fail_marked_step()`)
    }

    const after = await read(editor, workspace.id, guide.id)
    expect(titles(after)).toEqual(['One', 'Two', 'Three'])
    expect(after.steps.map((step) => step.id)).toEqual([one.id, two.id, three.id])
    expect(after.revision).toBe(2)
  })

  it('refuses a list based on an older revision and changes nothing', async () => {
    const { workspace, editor, guide } = await withThreeSteps()

    const stale = await replace(editor, workspace.id, guide.id, 1, [
      { title: 'Overwrite', body: body('Lost update.') },
    ])

    expect(stale.statusCode).toBe(409)
    expect(titles(await read(editor, workspace.id, guide.id))).toEqual(['One', 'Two', 'Three'])
  })

  it("refuses step ids of another guide or another workspace's guide", async () => {
    const { workspace, application, editor, guide, draft } = await withThreeSteps()
    const sibling = await createGuide(app, editor, workspace.id, application.id, 'Sibling')
    const siblingSteps = guideSchema.parse(
      (
        await replace(editor, workspace.id, sibling.id, 1, [
          { title: 'Sibling step', body: body('x') },
        ])
      ).json(),
    ).steps
    const other = await workspaceWithEveryRole(app, 'Globex')
    const otherApplication = await createApplication(
      app,
      other.people.owner.cookie,
      other.workspace.id,
    )
    const otherGuide = await createGuide(
      app,
      other.people.editor.cookie,
      other.workspace.id,
      otherApplication.id,
    )
    const otherSteps = guideSchema.parse(
      (
        await replace(other.people.editor.cookie, other.workspace.id, otherGuide.id, 1, [
          { title: 'Globex step', body: body('x') },
        ])
      ).json(),
    ).steps

    for (const foreign of [siblingSteps[0], otherSteps[0]]) {
      if (!foreign) throw new Error('missing step')
      const response = await replace(editor, workspace.id, guide.id, 2, [
        { id: foreign.id, title: 'Stolen', body: body('x') },
      ])
      expect(response.statusCode).toBe(404)
      expect(apiErrorSchema.parse(response.json()).error.message).toMatch(/does not belong/)
    }
    expect(titles(await read(editor, workspace.id, guide.id))).toEqual(titles(draft))
    const otherAfter = await read(other.people.editor.cookie, other.workspace.id, otherGuide.id)
    expect(titles(otherAfter)).toEqual(['Globex step'])
  })

  it.each([
    [
      'a step listed twice',
      (id: string) => [
        { id, title: 'A', body: body('a') },
        { id, title: 'B', body: body('b') },
      ],
    ],
    ['a client-chosen position', () => [{ title: 'A', body: body('a'), position: 7 }]],
    [
      'HTML in the body',
      () => [
        { title: 'A', body: { version: 1, blocks: [{ type: 'html', html: '<img onerror=x>' }] } },
      ],
    ],
    ['an unknown body version', () => [{ title: 'A', body: { version: 2, blocks: [] } }]],
    [
      'an unknown descriptor version',
      () => [{ title: 'A', body: body('a'), target: { ...targetDescriptor(), version: 999 } }],
    ],
    ['an unknown placement', () => [{ title: 'A', body: body('a'), placement: 'center' }]],
    ['an empty title', () => [{ title: ' ', body: body('a') }]],
    [
      'more than 50 steps',
      () => Array.from({ length: 51 }, () => ({ title: 'A', body: body('a') })),
    ],
  ])('rejects %s', async (_, steps) => {
    const { workspace, editor, guide, draft } = await withThreeSteps()

    const response = await replace(
      editor,
      workspace.id,
      guide.id,
      2,
      steps(draft.steps[0]?.id ?? ''),
    )

    expect(response.statusCode).toBe(400)
    expect(titles(await read(editor, workspace.id, guide.id))).toEqual(['One', 'Two', 'Three'])
  })

  it('refuses changes to an archived guide and to members', async () => {
    const { workspace, people, editor, guide } = await withThreeSteps()

    expect((await replace(people.member.cookie, workspace.id, guide.id, 2, [])).statusCode).toBe(
      403,
    )
    await call(app, 'DELETE', guidePath(workspace.id, guide.id), editor)
    expect((await replace(editor, workspace.id, guide.id, 2, [])).statusCode).toBe(409)
  })

  it('accepts a full guide of 50 steps at their size limits (over the 1 MiB default)', async () => {
    const { workspace, editor, guide } = await setup()
    const target = targetDescriptor()
    const part = 'p'.repeat(240)
    // 20 paragraphs × 10 runs of 10 characters: 2000 characters and 200 runs, the maximum.
    const body = {
      version: 1,
      blocks: Array.from({ length: 20 }, () => ({
        type: 'paragraph',
        children: Array.from({ length: 10 }, () => ({
          type: 'text',
          text: 'x'.repeat(10),
          marks: ['bold', 'italic', 'code'],
        })),
      })),
    }
    const steps = Array.from({ length: 50 }, (_, index) => ({
      title: `Step ${String(index + 1)}`,
      body,
      target: {
        ...target,
        locators: Array.from({ length: 12 }, () => ({
          strategy: 'xpath',
          expression: 'x'.repeat(500),
          scope: 'root',
          matchCount: 1,
        })),
        framePath: Array.from({ length: 5 }, () => ({
          urlPattern: { hostname: part, pathname: `/${part}`, search: part, hash: part },
        })),
      },
    }))
    const payload = { expectedRevision: 1, steps }
    expect(JSON.stringify(payload).length).toBeGreaterThan(1024 * 1024)

    const response = await call(app, 'PUT', stepsPath(workspace.id, guide.id), editor, payload)

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200)
    expect(guideSchema.parse(response.json()).stepCount).toBe(50)
  })
})
