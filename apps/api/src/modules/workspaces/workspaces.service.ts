import type { Member, WorkspaceRole, WorkspaceSummary } from '@contextlayer/shared'

import type { DbExecutor, DrizzleDatabase } from '../../infrastructure/database/client.js'
import {
  countOwners,
  deleteMember,
  findMembership,
  insertMember,
  insertWorkspaceWithOwner,
  listMembers,
  listWorkspacesForUser,
  lockWorkspace,
  updateMemberRole,
  type WorkspaceMembership,
} from './workspaces.repository.js'

/**
 * Authorization rules (docs/api.md):
 * - Not a member → `not-found`: a workspace id never reveals that it exists.
 * - Any member can read the workspace and its member list.
 * - `admin` and `owner` manage members; only an `owner` grants, changes or
 *   removes the `owner` role.
 * - Anyone may leave; the last owner can neither leave nor be demoted.
 */
export type WorkspaceError =
  | 'not-found'
  | 'forbidden'
  | 'user-not-found'
  | 'member-not-found'
  | 'already-member'
  | 'last-owner'

export type Result<T> = { ok: true; value: T } | { ok: false; error: WorkspaceError }

const fail = (error: WorkspaceError): { ok: false; error: WorkspaceError } => ({ ok: false, error })

const canManageMembers = (role: WorkspaceRole) => role === 'owner' || role === 'admin'

export function toWorkspaceSummary({ workspace, role }: WorkspaceMembership): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    role,
    createdAt: workspace.createdAt.toISOString(),
  }
}

/** What this module needs from the auth module (wired in app.ts). */
export interface UserDirectory {
  findUserIdByEmail(email: string): Promise<string | undefined>
  getProfiles(
    userIds: readonly string[],
  ): Promise<Map<string, { email: string; displayName: string }>>
}

export type WorkspacesService = ReturnType<typeof createWorkspacesService>

export function createWorkspacesService(deps: { db: DrizzleDatabase; users: UserDirectory }) {
  const { db, users } = deps

  async function membersWithProfiles(executor: DbExecutor, workspaceId: string): Promise<Member[]> {
    const rows = await listMembers(executor, workspaceId)
    const profiles = await users.getProfiles(rows.map((row) => row.userId))
    return rows.flatMap((row) => {
      const profile = profiles.get(row.userId)
      return profile
        ? [{ ...profile, userId: row.userId, role: row.role, joinedAt: row.joinedAt.toISOString() }]
        : []
    })
  }

  async function memberOf(executor: DbExecutor, workspaceId: string, userId: string) {
    return (await membersWithProfiles(executor, workspaceId)).find((m) => m.userId === userId)
  }

  return {
    async listForUser(userId: string): Promise<WorkspaceSummary[]> {
      return (await listWorkspacesForUser(db, userId)).map(toWorkspaceSummary)
    },

    async create(userId: string, name: string): Promise<WorkspaceSummary> {
      const membership = await db.transaction((tx) =>
        insertWorkspaceWithOwner(tx, { name, ownerId: userId }),
      )
      return toWorkspaceSummary(membership)
    },

    async get(userId: string, workspaceId: string): Promise<Result<WorkspaceSummary>> {
      const membership = await findMembership(db, workspaceId, userId)
      return membership ? { ok: true, value: toWorkspaceSummary(membership) } : fail('not-found')
    },

    async listMembers(userId: string, workspaceId: string): Promise<Result<Member[]>> {
      if (!(await findMembership(db, workspaceId, userId))) return fail('not-found')
      return { ok: true, value: await membersWithProfiles(db, workspaceId) }
    },

    async addMember(
      actorId: string,
      workspaceId: string,
      input: { email: string; role: WorkspaceRole },
    ): Promise<Result<Member>> {
      return db.transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId)
        const actor = await findMembership(tx, workspaceId, actorId)
        if (!actor) return fail('not-found')
        if (!canManageMembers(actor.role)) return fail('forbidden')
        if (input.role === 'owner' && actor.role !== 'owner') return fail('forbidden')

        const userId = await users.findUserIdByEmail(input.email)
        if (userId === undefined) return fail('user-not-found')
        const inserted = await insertMember(tx, { workspaceId, userId, role: input.role })
        if (!inserted.ok) return fail('already-member')

        const member = await memberOf(tx, workspaceId, userId)
        return member ? { ok: true, value: member } : fail('member-not-found')
      })
    },

    async updateRole(
      actorId: string,
      workspaceId: string,
      targetId: string,
      role: WorkspaceRole,
    ): Promise<Result<Member>> {
      return db.transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId)
        const actor = await findMembership(tx, workspaceId, actorId)
        if (!actor) return fail('not-found')
        if (!canManageMembers(actor.role)) return fail('forbidden')
        const target = await findMembership(tx, workspaceId, targetId)
        if (!target) return fail('member-not-found')
        if ((target.role === 'owner' || role === 'owner') && actor.role !== 'owner') {
          return fail('forbidden')
        }
        if (
          target.role === 'owner' &&
          role !== 'owner' &&
          (await countOwners(tx, workspaceId)) <= 1
        ) {
          return fail('last-owner')
        }

        await updateMemberRole(tx, { workspaceId, userId: targetId, role })
        const member = await memberOf(tx, workspaceId, targetId)
        return member ? { ok: true, value: member } : fail('member-not-found')
      })
    },

    async removeMember(
      actorId: string,
      workspaceId: string,
      targetId: string,
    ): Promise<Result<null>> {
      return db.transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId)
        const actor = await findMembership(tx, workspaceId, actorId)
        if (!actor) return fail('not-found')
        const target = await findMembership(tx, workspaceId, targetId)
        if (!target) return fail('member-not-found')

        const leaving = actorId === targetId
        if (!leaving && !canManageMembers(actor.role)) return fail('forbidden')
        if (!leaving && target.role === 'owner' && actor.role !== 'owner') return fail('forbidden')
        if (target.role === 'owner' && (await countOwners(tx, workspaceId)) <= 1) {
          return fail('last-owner')
        }

        await deleteMember(tx, workspaceId, targetId)
        return { ok: true, value: null }
      })
    },
  }
}
