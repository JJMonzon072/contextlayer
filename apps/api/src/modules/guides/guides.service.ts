import {
  roleAtLeast,
  type CreateGuideRequest,
  type Guide,
  type GuideList,
  type GuideListQuery,
  type GuideStep,
  type GuideSummary,
  type UpdateGuideRequest,
} from '@contextlayer/shared'

import { toPage } from '../../http/cursor.js'
import {
  isForeignKeyViolation,
  type DbExecutor,
  type DrizzleDatabase,
} from '../../infrastructure/database/client.js'
import type { MembershipDirectory } from '../applications/applications.service.js'
import {
  findGuide,
  insertGuide,
  listGuides,
  listSteps,
  lockGuide,
  setGuideStatus,
  updateGuideDraft,
  type GuideRow,
  type StepRow,
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

export type Result<T> = { ok: true; value: T } | { ok: false; error: GuideError }

const fail = (error: GuideError): { ok: false; error: GuideError } => ({ ok: false, error })

/** What this module needs from the applications module (wired in app.ts). */
export interface ApplicationDirectory {
  exists(workspaceId: string, applicationId: string): Promise<boolean>
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
}) {
  const { db, memberships, applications } = deps

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
