import type {
  GuideStatus,
  RichText,
  StepPlacement,
  TargetDescriptor,
  UrlPattern,
} from '@contextlayer/shared'
import { and, asc, desc, eq, inArray, lt, ne, notInArray, sql } from 'drizzle-orm'

import type { DbExecutor } from '../../infrastructure/database/client.js'
import { guideSteps, guides } from './guides.schema.js'

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

/**
 * Correlated subqueries over the outer `guides` row. Written with explicit
 * aliases: in a single-table select Drizzle renders columns unqualified, which
 * would make `guide_id = id` compare the inner table with itself.
 */
function latestVersionColumns() {
  return {
    stepCount: sql<number>`(select count(*)::int from "guide_steps" as s where s."guide_id" = "guides"."id")`,
    latestVersion: sql<
      number | null
    >`(select max(v."version") from "guide_versions" as v where v."guide_id" = "guides"."id")`,
    latestRevision: sql<
      number | null
    >`(select v."guide_revision" from "guide_versions" as v where v."guide_id" = "guides"."id" order by v."version" desc limit 1)`,
  }
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
  ...latestVersionColumns(),
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

/** The editable content of one step; its position is its index in the list. */
export interface StepValues {
  position: number
  title: string
  body: RichText
  target: TargetDescriptor | null
  urlPattern: UrlPattern | null
  placement: StepPlacement
}

/** Step writes reach rows only through a guide of the workspace. */
function stepsOfGuide(db: DbExecutor, workspaceId: string, guideId: string) {
  return inArray(
    guideSteps.guideId,
    db.select({ id: guides.id }).from(guides).where(inWorkspace(workspaceId, guideId)),
  )
}

export async function deleteStepsExcept(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
  keepIds: readonly string[],
): Promise<void> {
  await db
    .delete(guideSteps)
    .where(
      and(
        stepsOfGuide(db, workspaceId, guideId),
        keepIds.length > 0 ? notInArray(guideSteps.id, [...keepIds]) : undefined,
      ),
    )
}

export async function updateStep(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
  stepId: string,
  values: StepValues,
): Promise<void> {
  await db
    .update(guideSteps)
    .set(values)
    .where(and(eq(guideSteps.id, stepId), stepsOfGuide(db, workspaceId, guideId)))
}

/** The caller holds the guide lock, so `guideId` is known to belong to the workspace. */
export async function insertSteps(
  db: DbExecutor,
  guideId: string,
  steps: readonly StepValues[],
): Promise<void> {
  if (steps.length === 0) return
  await db.insert(guideSteps).values(steps.map((step) => ({ ...step, guideId })))
}
