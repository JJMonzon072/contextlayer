import type {
  GuideStatus,
  RichText,
  StepPlacement,
  TargetDescriptor,
  UrlPattern,
} from '@contextlayer/shared'
import { and, asc, desc, eq, lt, ne, sql } from 'drizzle-orm'

import type { DbExecutor } from '../../infrastructure/database/client.js'
import { guideSteps, guideVersions, guides } from './guides.schema.js'

/**
 * Every read and write is scoped by `workspaceId`; step queries reach their
 * rows only through a guide of that workspace. An id from another workspace
 * therefore behaves exactly like an id that does not exist.
 */

export interface GuideRow {
  id: string
  applicationId: string
  title: string
  description: string
  status: GuideStatus
  revision: number
  startUrlPattern: UrlPattern | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  stepCount: number
  latestVersion: number | null
  /** The draft revision the latest version froze. */
  latestRevision: number | null
}

export interface StepRow {
  id: string
  position: number
  title: string
  body: RichText
  target: TargetDescriptor | null
  urlPattern: UrlPattern | null
  placement: StepPlacement
}

const guideColumns = {
  id: guides.id,
  applicationId: guides.applicationId,
  title: guides.title,
  description: guides.description,
  status: guides.status,
  revision: guides.revision,
  startUrlPattern: guides.startUrlPattern,
  createdAt: guides.createdAt,
  updatedAt: guides.updatedAt,
  archivedAt: guides.archivedAt,
  stepCount: sql<number>`(select count(*)::int from ${guideSteps} where ${guideSteps.guideId} = ${guides.id})`,
  latestVersion: sql<
    number | null
  >`(select max(${guideVersions.version}) from ${guideVersions} where ${guideVersions.guideId} = ${guides.id})`,
  latestRevision: sql<
    number | null
  >`(select ${guideVersions.guideRevision} from ${guideVersions} where ${guideVersions.guideId} = ${guides.id} order by ${guideVersions.version} desc limit 1)`,
}

const inWorkspace = (workspaceId: string, guideId: string) =>
  and(eq(guides.workspaceId, workspaceId), eq(guides.id, guideId))

/** Newest first by UUIDv7 id; without `status`, archived guides are left out. Fetches `limit + 1`. */
export function listGuides(
  db: DbExecutor,
  workspaceId: string,
  filter: {
    applicationId: string | undefined
    status: GuideStatus | undefined
    limit: number
    afterId: string | undefined
  },
): Promise<GuideRow[]> {
  return db
    .select(guideColumns)
    .from(guides)
    .where(
      and(
        eq(guides.workspaceId, workspaceId),
        filter.applicationId === undefined
          ? undefined
          : eq(guides.applicationId, filter.applicationId),
        filter.status === undefined
          ? ne(guides.status, 'archived')
          : eq(guides.status, filter.status),
        filter.afterId === undefined ? undefined : lt(guides.id, filter.afterId),
      ),
    )
    .orderBy(desc(guides.id))
    .limit(filter.limit + 1)
}

export async function findGuide(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
): Promise<GuideRow | undefined> {
  const [row] = await db.select(guideColumns).from(guides).where(inWorkspace(workspaceId, guideId))
  return row
}

export interface LockedGuide {
  id: string
  applicationId: string
  title: string
  description: string
  startUrlPattern: UrlPattern | null
  status: GuideStatus
  revision: number
}

/**
 * Locks the guide row for the rest of the transaction. Every draft change,
 * step replacement and publish takes this lock first, so they run one at a
 * time per guide and a publish always reads a consistent draft.
 */
export async function lockGuide(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
): Promise<LockedGuide | undefined> {
  const [row] = await db
    .select({
      id: guides.id,
      applicationId: guides.applicationId,
      title: guides.title,
      description: guides.description,
      startUrlPattern: guides.startUrlPattern,
      status: guides.status,
      revision: guides.revision,
    })
    .from(guides)
    .where(inWorkspace(workspaceId, guideId))
    .for('update')
  return row
}

export async function insertGuide(
  db: DbExecutor,
  input: {
    workspaceId: string
    applicationId: string
    title: string
    description: string
    startUrlPattern: UrlPattern | null
    createdBy: string
  },
): Promise<string> {
  const [row] = await db.insert(guides).values(input).returning({ id: guides.id })
  if (!row) throw new Error('insert into guides returned no row')
  return row.id
}

/** Applies draft metadata changes and moves the draft to its next revision. */
export async function updateGuideDraft(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
  changes: {
    title?: string | undefined
    description?: string | undefined
    startUrlPattern?: UrlPattern | null | undefined
  },
): Promise<void> {
  await db
    .update(guides)
    .set({
      ...(changes.title !== undefined && { title: changes.title }),
      ...(changes.description !== undefined && { description: changes.description }),
      ...(changes.startUrlPattern !== undefined && { startUrlPattern: changes.startUrlPattern }),
      revision: sql`${guides.revision} + 1`,
    })
    .where(inWorkspace(workspaceId, guideId))
}

export async function setGuideStatus(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
  status: GuideStatus,
): Promise<void> {
  await db
    .update(guides)
    .set({ status, archivedAt: status === 'archived' ? sql`now()` : null })
    .where(inWorkspace(workspaceId, guideId))
}

export function listSteps(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
): Promise<StepRow[]> {
  return db
    .select({
      id: guideSteps.id,
      position: guideSteps.position,
      title: guideSteps.title,
      body: guideSteps.body,
      target: guideSteps.target,
      urlPattern: guideSteps.urlPattern,
      placement: guideSteps.placement,
    })
    .from(guideSteps)
    .innerJoin(guides, eq(guides.id, guideSteps.guideId))
    .where(inWorkspace(workspaceId, guideId))
    .orderBy(asc(guideSteps.position))
}
