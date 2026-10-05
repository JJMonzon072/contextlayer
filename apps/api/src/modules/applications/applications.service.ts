import type {
  Application,
  ApplicationList,
  CreateApplicationRequest,
  UpdateApplicationRequest,
  WorkspaceRole,
} from '@contextlayer/shared'
import { roleAtLeast } from '@contextlayer/shared'

import { toPage } from '../../http/cursor.js'
import type { DrizzleDatabase } from '../../infrastructure/database/client.js'
import {
  deleteApplication,
  findApplication,
  insertApplication,
  listApplications,
  updateApplication,
  type ApplicationRow,
} from './applications.repository.js'

/**
 * Authorization (docs/api.md): any member reads applications; `admin` and
 * `owner` create, change and delete them. A non-member gets `not-found`, like a
 * workspace that does not exist.
 */
export type ApplicationError = 'not-found' | 'forbidden' | 'application-not-found' | 'has-guides'

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApplicationError }

const fail = (error: ApplicationError): { ok: false; error: ApplicationError } => ({
  ok: false,
  error,
})

/** What this module needs from the workspaces module (wired in app.ts). */
export interface MembershipDirectory {
  roleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined>
}

export function toApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    name: row.name,
    origins: row.origins,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export type ApplicationsService = ReturnType<typeof createApplicationsService>

export function createApplicationsService(deps: {
  db: DrizzleDatabase
  memberships: MembershipDirectory
}) {
  const { db, memberships } = deps

  async function authorize(
    userId: string,
    workspaceId: string,
    minimum: WorkspaceRole,
  ): Promise<ApplicationError | undefined> {
    const role = await memberships.roleOf(workspaceId, userId)
    if (role === undefined) return 'not-found'
    return roleAtLeast(role, minimum) ? undefined : 'forbidden'
  }

  return {
    /** For the guides module: does this application belong to this workspace? */
    async exists(workspaceId: string, applicationId: string): Promise<boolean> {
      return (await findApplication(db, workspaceId, applicationId)) !== undefined
    },

    async list(
      userId: string,
      workspaceId: string,
      page: { limit: number; afterId: string | undefined },
    ): Promise<Result<ApplicationList>> {
      const denied = await authorize(userId, workspaceId, 'member')
      if (denied) return fail(denied)
      const rows = await listApplications(db, workspaceId, page)
      return { ok: true, value: toPage(rows, page.limit, toApplication) }
    },

    async get(
      userId: string,
      workspaceId: string,
      applicationId: string,
    ): Promise<Result<Application>> {
      const denied = await authorize(userId, workspaceId, 'member')
      if (denied) return fail(denied)
      const row = await findApplication(db, workspaceId, applicationId)
      return row ? { ok: true, value: toApplication(row) } : fail('application-not-found')
    },

    async create(
      userId: string,
      workspaceId: string,
      input: CreateApplicationRequest,
    ): Promise<Result<Application>> {
      const denied = await authorize(userId, workspaceId, 'admin')
      if (denied) return fail(denied)
      const row = await insertApplication(db, { workspaceId, ...input })
      return { ok: true, value: toApplication(row) }
    },

    async update(
      userId: string,
      workspaceId: string,
      applicationId: string,
      input: UpdateApplicationRequest,
    ): Promise<Result<Application>> {
      const denied = await authorize(userId, workspaceId, 'admin')
      if (denied) return fail(denied)
      const row = await updateApplication(db, workspaceId, applicationId, input)
      return row ? { ok: true, value: toApplication(row) } : fail('application-not-found')
    },

    async remove(
      userId: string,
      workspaceId: string,
      applicationId: string,
    ): Promise<Result<null>> {
      const denied = await authorize(userId, workspaceId, 'admin')
      if (denied) return fail(denied)
      const result = await deleteApplication(db, workspaceId, applicationId)
      if (result === 'deleted') return { ok: true, value: null }
      return fail(result === 'not-found' ? 'application-not-found' : 'has-guides')
    },
  }
}
