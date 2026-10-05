import type { GuideSnapshot } from '@contextlayer/shared'
import { and, desc, eq, sql } from 'drizzle-orm'

import type { DbExecutor } from '../../infrastructure/database/client.js'
import { guideVersions, guides } from './guides.schema.js'

/**
 * Published versions are insert-only: this module has no update or delete
 * function, and a trigger rejects UPDATE in the database (ADR 0016). Reads
 * reach a version only through a guide of the caller's workspace.
 */

export interface VersionRow {
  version: number
  guideRevision: number
  publishedAt: Date
  publishedBy: string | null
  stepCount: number
}

const versionColumns = {
  version: guideVersions.version,
  guideRevision: guideVersions.guideRevision,
  publishedAt: guideVersions.publishedAt,
  publishedBy: guideVersions.publishedBy,
  stepCount: sql<number>`jsonb_array_length("guide_versions"."snapshot" -> 'steps')`,
}

const ofGuide = (workspaceId: string, guideId: string) =>
  and(eq(guides.workspaceId, workspaceId), eq(guides.id, guideId))

export async function findLatestVersion(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
): Promise<VersionRow | undefined> {
  const [row] = await db
    .select(versionColumns)
    .from(guideVersions)
    .innerJoin(guides, eq(guides.id, guideVersions.guideId))
    .where(ofGuide(workspaceId, guideId))
    .orderBy(desc(guideVersions.version))
    .limit(1)
  return row
}

/** Newest first. Version lists are short, so they are not paginated. */
export function listVersions(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
): Promise<VersionRow[]> {
  return db
    .select(versionColumns)
    .from(guideVersions)
    .innerJoin(guides, eq(guides.id, guideVersions.guideId))
    .where(ofGuide(workspaceId, guideId))
    .orderBy(desc(guideVersions.version))
}

export async function findVersion(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
  version: number,
): Promise<(VersionRow & { snapshot: GuideSnapshot }) | undefined> {
  const [row] = await db
    .select({ ...versionColumns, snapshot: guideVersions.snapshot })
    .from(guideVersions)
    .innerJoin(guides, eq(guides.id, guideVersions.guideId))
    .where(and(ofGuide(workspaceId, guideId), eq(guideVersions.version, version)))
  return row
}

/** The caller holds the guide lock and checked the guide belongs to the workspace. */
export async function insertVersion(
  db: DbExecutor,
  input: {
    guideId: string
    version: number
    guideRevision: number
    snapshot: GuideSnapshot
    publishedBy: string
  },
): Promise<VersionRow> {
  const [row] = await db.insert(guideVersions).values(input).returning({
    version: guideVersions.version,
    guideRevision: guideVersions.guideRevision,
    publishedAt: guideVersions.publishedAt,
    publishedBy: guideVersions.publishedBy,
  })
  if (!row) throw new Error('insert into guide_versions returned no row')
  return { ...row, stepCount: input.snapshot.steps.length }
}
