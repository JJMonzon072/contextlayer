import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  applications,
  guideSteps,
  guideVersions,
  guides,
  users,
  workspaces,
} from '../../src/infrastructure/database/schema.js'
import { connectTestDatabase, resetTestDatabase } from './support/test-database.js'

/**
 * The invariants PostgreSQL itself enforces, tested without the API: code that
 * bypasses the services still cannot store them.
 */
const database = connectTestDatabase()
const { db } = database

afterAll(() => database.close())
beforeEach(() => resetTestDatabase(database))

const BODY = { version: 1 as const, blocks: [] }

/** The SQLSTATE of the driver error Drizzle wraps. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    return typeof cause === 'object' && cause !== null && 'code' in cause
      ? String(cause.code)
      : 'unknown'
  }
}

async function tenant(name: string) {
  const [workspace] = await db.insert(workspaces).values({ name }).returning()
  if (!workspace) throw new Error('no workspace')
  const [application] = await db
    .insert(applications)
    .values({
      workspaceId: workspace.id,
      name: `${name} CRM`,
      origins: ['https://crm.example.com'],
    })
    .returning()
  if (!application) throw new Error('no application')
  return { workspace, application }
}

async function guideIn(workspaceId: string, applicationId: string) {
  const [guide] = await db
    .insert(guides)
    .values({ workspaceId, applicationId, title: 'Create a customer' })
    .returning()
  if (!guide) throw new Error('no guide')
  return guide
}

describe('applications', () => {
  it.each([
    ['a path', ['https://crm.example.com/login']],
    ['a query', ['https://crm.example.com?x=1']],
    ['a fragment', ['https://crm.example.com#a']],
    ['credentials', ['https://u:p@crm.example.com']],
    ['a wildcard', ['https://*.example.com']],
    ['upper case', ['https://CRM.example.com']],
    ['another scheme', ['javascript://crm.example.com']],
    ['no origins', []],
  ])('reject an origin with %s', async (_, origins) => {
    const { workspace } = await tenant('Acme')
    expect(
      await sqlState(
        db.insert(applications).values({ workspaceId: workspace.id, name: 'X', origins }),
      ),
    ).toBe('23514')
  })

  it('cannot be deleted while a guide references it', async () => {
    const { workspace, application } = await tenant('Acme')
    await guideIn(workspace.id, application.id)

    // ON DELETE RESTRICT reports restrict_violation.
    expect(await sqlState(db.delete(applications).where(eq(applications.id, application.id)))).toBe(
      '23001',
    )
  })
})

describe('guides', () => {
  it("cannot use another workspace's application (composite foreign key)", async () => {
    const a = await tenant('Acme')
    const b = await tenant('Globex')

    expect(
      await sqlState(
        db
          .insert(guides)
          .values({ workspaceId: b.workspace.id, applicationId: a.application.id, title: 'X' }),
      ),
    ).toBe('23503')
  })

  it('keeps status and archived_at consistent', async () => {
    const { workspace, application } = await tenant('Acme')
    const guide = await guideIn(workspace.id, application.id)

    expect(
      await sqlState(db.update(guides).set({ status: 'archived' }).where(eq(guides.id, guide.id))),
    ).toBe('23514')
  })
})

describe('guide steps', () => {
  it('allows reordering inside a transaction (positions checked at commit)', async () => {
    const { workspace, application } = await tenant('Acme')
    const guide = await guideIn(workspace.id, application.id)
    const [first, second] = await db
      .insert(guideSteps)
      .values([
        { guideId: guide.id, position: 0, title: 'First', body: BODY },
        { guideId: guide.id, position: 1, title: 'Second', body: BODY },
      ])
      .returning()
    if (!first || !second) throw new Error('no steps')

    await db.transaction(async (tx) => {
      await tx.update(guideSteps).set({ position: 1 }).where(eq(guideSteps.id, first.id))
      await tx.update(guideSteps).set({ position: 0 }).where(eq(guideSteps.id, second.id))
    })

    const rows = await db
      .select({ title: guideSteps.title })
      .from(guideSteps)
      .orderBy(guideSteps.position)
    expect(rows.map((row) => row.title)).toEqual(['Second', 'First'])
  })

  it('rejects two steps at the same position when the transaction commits', async () => {
    const { workspace, application } = await tenant('Acme')
    const guide = await guideIn(workspace.id, application.id)

    expect(
      await sqlState(
        db.insert(guideSteps).values([
          { guideId: guide.id, position: 0, title: 'A', body: BODY },
          { guideId: guide.id, position: 0, title: 'B', body: BODY },
        ]),
      ),
    ).toBe('23505')
  })

  it('stores only versioned JSON documents', async () => {
    const { workspace, application } = await tenant('Acme')
    const guide = await guideIn(workspace.id, application.id)

    expect(
      await sqlState(
        db.execute(
          sql`insert into guide_steps (guide_id, position, title, body) values (${guide.id}, 0, 'A', '"text"'::jsonb)`,
        ),
      ),
    ).toBe('23514')
  })
})

describe('guide versions', () => {
  async function publishedGuide() {
    const { workspace, application } = await tenant('Acme')
    const guide = await guideIn(workspace.id, application.id)
    const snapshot = {
      version: 1 as const,
      guide: {
        id: guide.id,
        applicationId: application.id,
        title: guide.title,
        description: '',
        startUrlPattern: null,
      },
      steps: [],
    }
    await db
      .insert(guideVersions)
      .values({ guideId: guide.id, version: 1, guideRevision: 1, snapshot })
    return { guide, snapshot }
  }

  it('cannot be updated, not even by direct SQL', async () => {
    const { guide } = await publishedGuide()

    expect(
      await sqlState(
        db.update(guideVersions).set({ version: 9 }).where(eq(guideVersions.guideId, guide.id)),
      ),
    ).toBe('23000')
  })

  it('cannot be deleted, not even by direct SQL, while new versions can still be added', async () => {
    const { guide, snapshot } = await publishedGuide()
    const versionsOfGuide = () =>
      db
        .select({ version: guideVersions.version, snapshot: guideVersions.snapshot })
        .from(guideVersions)
        .where(eq(guideVersions.guideId, guide.id))
        .orderBy(guideVersions.version)

    expect(
      await sqlState(db.delete(guideVersions).where(eq(guideVersions.guideId, guide.id))),
    ).toBe('23000')
    expect(
      await sqlState(db.execute(sql`delete from guide_versions where guide_id = ${guide.id}`)),
    ).toBe('23000')
    expect(await versionsOfGuide()).toEqual([{ version: 1, snapshot }])

    await db
      .insert(guideVersions)
      .values({ guideId: guide.id, version: 2, guideRevision: 2, snapshot })
    expect((await versionsOfGuide()).map((row) => row.version)).toEqual([1, 2])
  })

  it('never repeats a version number for a guide', async () => {
    const { guide, snapshot } = await publishedGuide()

    expect(
      await sqlState(
        db
          .insert(guideVersions)
          .values({ guideId: guide.id, version: 1, guideRevision: 2, snapshot }),
      ),
    ).toBe('23505')
  })

  it('keep their guide from being deleted', async () => {
    const { guide } = await publishedGuide()

    expect(await sqlState(db.delete(guides).where(eq(guides.id, guide.id)))).toBe('23001')
  })

  it('outlive the account that published them', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'p@example.com', passwordHash: 'x', displayName: 'P' })
      .returning()
    const { guide, snapshot } = await publishedGuide()
    if (!user) throw new Error('no user')
    await db
      .insert(guideVersions)
      .values({ guideId: guide.id, version: 2, guideRevision: 2, snapshot, publishedBy: user.id })

    await db.delete(users).where(eq(users.id, user.id))

    const [row] = await db
      .select({ publishedBy: guideVersions.publishedBy })
      .from(guideVersions)
      .where(eq(guideVersions.version, 2))
    expect(row).toEqual({ publishedBy: null })
  })
})
