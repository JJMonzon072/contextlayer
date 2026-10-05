import {
  guideSnapshotSchema,
  roleAtLeast,
  type CreateGuideRequest,
  type Guide,
  type GuideList,
  type GuideListQuery,
  type GuideStep,
  type GuideSummary,
  type GuideVersion,
  type GuideVersionSummary,
  type PublishGuideResponse,
  type ReplaceStepsRequest,
  type UpdateGuideRequest,
} from '@contextlayer/shared'

import { toPage } from '../../http/cursor.js'
import {
  isForeignKeyViolation,
  isUniqueViolation,
  type DbExecutor,
  type DrizzleDatabase,
} from '../../infrastructure/database/client.js'
import type { MembershipDirectory } from '../applications/applications.service.js'
import {
  findLatestVersion,
  findVersion,
  insertVersion,
  listVersions,
  type VersionRow,
} from './guide-versions.repository.js'
import {
  deleteStepsExcept,
  findGuide,
  insertGuide,
  insertSteps,
  listGuides,
  listSteps,
  lockGuide,
  setGuideStatus,
  updateGuideDraft,
  updateStep,
  type GuideRow,
  type StepRow,
  type StepValues,
} from './guides.repository.js'

/**
 * Authorization (docs/api.md): guides are authoring data, so every route needs
 * `editor` or above; `member` (learners) get 403 and will only ever receive
 * published versions, through the extension (Phase 4). A non-member gets
 * `not-found`, exactly like a workspace that does not exist.
 */
export type GuideError =
  | 'not-found'
  | 'forbidden'
  | 'guide-not-found'
  | 'application-not-found'
  | 'archived'
  | 'revision-conflict'
  | 'step-not-found'
  | 'no-steps'
  | 'version-not-found'
  | 'publish-conflict'

export type Result<T> = { ok: true; value: T } | { ok: false; error: GuideError }

const fail = (error: GuideError): { ok: false; error: GuideError } => ({ ok: false, error })

/** What this module needs from the applications module (wired in app.ts). */
export interface ApplicationDirectory {
  exists(workspaceId: string, applicationId: string): Promise<boolean>
}

/** What this module needs from the auth module: names of the people who published. */
export interface PublisherDirectory {
  getProfiles(userIds: readonly string[]): Promise<Map<string, { displayName: string }>>
}

export function toGuideSummary(row: GuideRow): GuideSummary {
  return {
    id: row.id,
    applicationId: row.applicationId,
    title: row.title,
    description: row.description,
    status: row.status,
    revision: row.revision,
    stepCount: row.stepCount,
    latestVersion: row.latestVersion,
    hasUnpublishedChanges: row.latestRevision !== row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

function toStep(row: StepRow): GuideStep {
  return { ...row }
}

export type GuidesService = ReturnType<typeof createGuidesService>

export function createGuidesService(deps: {
  db: DrizzleDatabase
  memberships: MembershipDirectory
  applications: ApplicationDirectory
  publishers: PublisherDirectory
}) {
  const { db, memberships, applications, publishers } = deps

  async function toVersionSummaries(rows: readonly VersionRow[]): Promise<GuideVersionSummary[]> {
    const ids = [...new Set(rows.flatMap((row) => (row.publishedBy ? [row.publishedBy] : [])))]
    const profiles =
      ids.length > 0
        ? await publishers.getProfiles(ids)
        : new Map<string, { displayName: string }>()
    return rows.map((row) => {
      const profile = row.publishedBy ? profiles.get(row.publishedBy) : undefined
      return {
        version: row.version,
        publishedAt: row.publishedAt.toISOString(),
        publishedBy:
          row.publishedBy && profile
            ? { userId: row.publishedBy, displayName: profile.displayName }
            : null,
        stepCount: row.stepCount,
      }
    })
  }

  async function toVersionSummary(row: VersionRow): Promise<GuideVersionSummary> {
    const [summary] = await toVersionSummaries([row])
    if (!summary) throw new Error('missing version summary')
    return summary
  }

  async function authorize(userId: string, workspaceId: string): Promise<GuideError | undefined> {
    const role = await memberships.roleOf(workspaceId, userId)
    if (role === undefined) return 'not-found'
    return roleAtLeast(role, 'editor') ? undefined : 'forbidden'
  }

  async function readGuide(
    executor: DbExecutor,
    workspaceId: string,
    guideId: string,
  ): Promise<Guide | undefined> {
    const row = await findGuide(executor, workspaceId, guideId)
    if (!row) return undefined
    const steps = await listSteps(executor, workspaceId, guideId)
    return {
      ...toGuideSummary(row),
      startUrlPattern: row.startUrlPattern,
      steps: steps.map(toStep),
    }
  }

  async function guideOrFail(
    executor: DbExecutor,
    workspaceId: string,
    guideId: string,
  ): Promise<Result<Guide>> {
    const guide = await readGuide(executor, workspaceId, guideId)
    return guide ? { ok: true, value: guide } : fail('guide-not-found')
  }

  return {
    async list(
      userId: string,
      workspaceId: string,
      query: Omit<GuideListQuery, 'cursor'> & { afterId: string | undefined },
    ): Promise<Result<GuideList>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      const rows = await listGuides(db, workspaceId, {
        applicationId: query.applicationId,
        status: query.status,
        limit: query.limit,
        afterId: query.afterId,
      })
      return { ok: true, value: toPage(rows, query.limit, toGuideSummary) }
    },

    async get(userId: string, workspaceId: string, guideId: string): Promise<Result<Guide>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      return guideOrFail(db, workspaceId, guideId)
    },

    async create(
      userId: string,
      workspaceId: string,
      input: CreateGuideRequest,
    ): Promise<Result<Guide>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      // The application must belong to this workspace; the composite foreign key
      // guides(workspace_id, application_id) enforces the same in the database.
      if (!(await applications.exists(workspaceId, input.applicationId))) {
        return fail('application-not-found')
      }
      try {
        const id = await insertGuide(db, {
          workspaceId,
          applicationId: input.applicationId,
          title: input.title,
          description: input.description ?? '',
          startUrlPattern: input.startUrlPattern ?? null,
          createdBy: userId,
        })
        return await guideOrFail(db, workspaceId, id)
      } catch (error) {
        // The application was deleted between the check and the insert.
        if (isForeignKeyViolation(error, 'guides_application_fk')) {
          return fail('application-not-found')
        }
        throw error
      }
    },

    async update(
      userId: string,
      workspaceId: string,
      guideId: string,
      input: UpdateGuideRequest,
    ): Promise<Result<Guide>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      return db.transaction(async (tx) => {
        const guide = await lockGuide(tx, workspaceId, guideId)
        if (!guide) return fail('guide-not-found')
        if (guide.status === 'archived') return fail('archived')
        if (input.expectedRevision !== undefined && input.expectedRevision !== guide.revision) {
          return fail('revision-conflict')
        }
        await updateGuideDraft(tx, workspaceId, guideId, input)
        return guideOrFail(tx, workspaceId, guideId)
      })
    },

    /**
     * Replaces the ordered list of steps in one transaction: steps missing from
     * the request are deleted, listed ones are updated (keeping their ids) and
     * new ones inserted, all at their index as position. Positions are checked
     * at commit (deferred unique constraint), and any failure rolls back the
     * whole replacement, so the previous order stays intact.
     */
    async replaceSteps(
      userId: string,
      workspaceId: string,
      guideId: string,
      input: ReplaceStepsRequest,
    ): Promise<Result<Guide>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      return db.transaction(async (tx) => {
        const guide = await lockGuide(tx, workspaceId, guideId)
        if (!guide) return fail('guide-not-found')
        if (guide.status === 'archived') return fail('archived')
        if (input.expectedRevision !== guide.revision) return fail('revision-conflict')

        const existing = new Set((await listSteps(tx, workspaceId, guideId)).map((step) => step.id))
        if (input.steps.some((step) => step.id !== undefined && !existing.has(step.id))) {
          return fail('step-not-found')
        }

        const values = input.steps.map(
          (step, position): StepValues & { id: string | undefined } => ({
            id: step.id,
            position,
            title: step.title,
            body: step.body,
            target: step.target ?? null,
            urlPattern: step.urlPattern ?? null,
            placement: step.placement ?? 'auto',
          }),
        )
        await deleteStepsExcept(
          tx,
          workspaceId,
          guideId,
          values.flatMap((step) => (step.id === undefined ? [] : [step.id])),
        )
        for (const { id, ...step } of values) {
          if (id !== undefined) await updateStep(tx, workspaceId, guideId, id, step)
        }
        await insertSteps(
          tx,
          guideId,
          values.flatMap(({ id, ...step }) => (id === undefined ? [step] : [])),
        )
        await updateGuideDraft(tx, workspaceId, guideId, {})
        return guideOrFail(tx, workspaceId, guideId)
      })
    },

    /**
     * Freezes the current draft into the next immutable version (ADR 0016).
     * Runs under the guide lock that every draft change also takes, so the
     * snapshot never mixes two drafts and two publishes cannot both create
     * version N (the unique (guide_id, version) constraint backs this up). If
     * the draft has not changed since the latest version, that version is
     * returned instead of a duplicate, which makes double clicks harmless.
     */
    async publish(
      userId: string,
      workspaceId: string,
      guideId: string,
    ): Promise<Result<PublishGuideResponse>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      return db.transaction(async (tx) => {
        const guide = await lockGuide(tx, workspaceId, guideId)
        if (!guide) return fail('guide-not-found')
        if (guide.status === 'archived') return fail('archived')

        const latest = await findLatestVersion(tx, workspaceId, guideId)
        const current = async () => {
          const row = await findGuide(tx, workspaceId, guideId)
          if (!row) throw new Error('locked guide disappeared')
          return toGuideSummary(row)
        }
        if (latest?.guideRevision === guide.revision) {
          return {
            ok: true,
            value: {
              created: false,
              version: await toVersionSummary(latest),
              guide: await current(),
            },
          }
        }

        const steps = await listSteps(tx, workspaceId, guideId)
        if (steps.length === 0) return fail('no-steps')
        const snapshot = guideSnapshotSchema.parse({
          version: 1,
          guide: {
            id: guide.id,
            applicationId: guide.applicationId,
            title: guide.title,
            description: guide.description,
            startUrlPattern: guide.startUrlPattern,
          },
          steps,
        })

        let inserted: VersionRow
        try {
          inserted = await insertVersion(tx, {
            guideId,
            version: (latest?.version ?? 0) + 1,
            guideRevision: guide.revision,
            snapshot,
            publishedBy: userId,
          })
        } catch (error) {
          if (isUniqueViolation(error, 'guide_versions_guide_id_version_key')) {
            return fail('publish-conflict')
          }
          throw error
        }
        if (guide.status === 'draft') await setGuideStatus(tx, workspaceId, guideId, 'published')
        return {
          ok: true,
          value: {
            created: true,
            version: await toVersionSummary(inserted),
            guide: await current(),
          },
        }
      })
    },

    async listVersions(
      userId: string,
      workspaceId: string,
      guideId: string,
    ): Promise<Result<GuideVersionSummary[]>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      if (!(await findGuide(db, workspaceId, guideId))) return fail('guide-not-found')
      return {
        ok: true,
        value: await toVersionSummaries(await listVersions(db, workspaceId, guideId)),
      }
    },

    async getVersion(
      userId: string,
      workspaceId: string,
      guideId: string,
      version: number,
    ): Promise<Result<GuideVersion>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      const row = await findVersion(db, workspaceId, guideId, version)
      if (!row) return fail('version-not-found')
      return {
        ok: true,
        value: { ...(await toVersionSummary(row)), guideId, snapshot: row.snapshot },
      }
    },

    /** Archiving hides the guide from players; versions are kept and it can be restored. */
    async archive(userId: string, workspaceId: string, guideId: string): Promise<Result<null>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      return db.transaction(async (tx) => {
        const guide = await lockGuide(tx, workspaceId, guideId)
        if (!guide) return fail('guide-not-found')
        if (guide.status !== 'archived') await setGuideStatus(tx, workspaceId, guideId, 'archived')
        return { ok: true, value: null }
      })
    },

    async restore(userId: string, workspaceId: string, guideId: string): Promise<Result<Guide>> {
      const denied = await authorize(userId, workspaceId)
      if (denied) return fail(denied)
      return db.transaction(async (tx) => {
        const guide = await lockGuide(tx, workspaceId, guideId)
        if (!guide) return fail('guide-not-found')
        if (guide.status === 'archived') {
          const row = await findGuide(tx, workspaceId, guideId)
          const status = row?.latestVersion === null ? 'draft' : 'published'
          await setGuideStatus(tx, workspaceId, guideId, status)
        }
        return guideOrFail(tx, workspaceId, guideId)
      })
    },
  }
}
