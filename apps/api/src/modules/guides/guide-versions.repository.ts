import type { GuideSnapshot, UrlPattern } from '@contextlayer/shared'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'

import type { DbExecutor } from '../../infrastructure/database/client.js'
import { guideVersions, guides } from './guides.schema.js'

/**
 * Published versions are insert-only: this module has no update or delete
 * function, and triggers reject DELETE and UPDATE in the database (ADR 0016). Reads
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

export interface PublishedRow {
  guideId: string
  applicationId: string
  version: number
  title: string
  description: string
  stepCount: number
  /** The published version's start page; null means any page of the origin. */
  startUrlPattern: UrlPattern | null
  publishedAt: Date
}

/** The latest version of the outer guide row (explicit aliases, see guides.repository.ts). */
const isLatestVersion = sql`${guideVersions.version} = (select max(v."version") from "guide_versions" as v where v."guide_id" = "guides"."id")`

const publishedColumns = {
  guideId: guides.id,
  applicationId: guides.applicationId,
  version: guideVersions.version,
  // Title and description come from the snapshot, never from the editable draft.
  title: sql<string>`"guide_versions"."snapshot" -> 'guide' ->> 'title'`,
  description: sql<string>`"guide_versions"."snapshot" -> 'guide' ->> 'description'`,
  stepCount: sql<number>`jsonb_array_length("guide_versions"."snapshot" -> 'steps')`,
  // JSON null and a missing key both read as null: no start page.
  startUrlPattern: sql<UrlPattern | null>`"guide_versions"."snapshot" -> 'guide' -> 'startUrlPattern'`,
  publishedAt: guideVersions.publishedAt,
}

/**
 * Published, non-archived guides of these applications in the workspace, each
 * with its latest version. Newest guide first; fetches `limit + 1`.
 */
export function listPublished(
  db: DbExecutor,
  workspaceId: string,
  applicationIds: readonly string[],
  page: { limit: number; afterId: string | undefined },
): Promise<PublishedRow[]> {
  if (applicationIds.length === 0) return Promise.resolve([])
  return db
    .select(publishedColumns)
    .from(guides)
    .innerJoin(guideVersions, and(eq(guideVersions.guideId, guides.id), isLatestVersion))
    .where(
      and(
        eq(guides.workspaceId, workspaceId),
        inArray(guides.applicationId, [...applicationIds]),
        eq(guides.status, 'published'),
        page.afterId === undefined ? undefined : lt(guides.id, page.afterId),
      ),
    )
    .orderBy(desc(guides.id))
    .limit(page.limit + 1)
}

/** The latest published snapshot of a non-archived guide of the workspace. */
export async function findPublished(
  db: DbExecutor,
  workspaceId: string,
  guideId: string,
): Promise<(PublishedRow & { snapshot: GuideSnapshot }) | undefined> {
  const [row] = await db
    .select({ ...publishedColumns, snapshot: guideVersions.snapshot })
    .from(guides)
    .innerJoin(guideVersions, and(eq(guideVersions.guideId, guides.id), isLatestVersion))
    .where(
      and(
        eq(guides.workspaceId, workspaceId),
        eq(guides.id, guideId),
        eq(guides.status, 'published'),
      ),
    )
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
