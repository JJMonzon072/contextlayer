import type { WorkspaceRole } from '@contextlayer/shared'
import { and, asc, count, eq } from 'drizzle-orm'

import { isUniqueViolation, type DbExecutor } from '../../infrastructure/database/client.js'
import { users } from '../auth/auth.schema.js'
import { workspaceMembers, workspaces } from './workspaces.schema.js'

/**
 * Every function that reads or writes workspace data takes the `workspaceId`
 * explicitly: there is no unscoped lookup by id. Authorization (membership and
 * role) is decided by the service before these functions are called.
 */

export interface WorkspaceMembership {
  workspace: { id: string; name: string; createdAt: Date }
  role: WorkspaceRole
}

export async function insertWorkspaceWithOwner(
  db: DbExecutor,
  input: { name: string; ownerId: string },
): Promise<WorkspaceMembership> {
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: input.name })
    .returning({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
  if (!workspace) throw new Error('insert into workspaces returned no row')
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace.id, userId: input.ownerId, role: 'owner' })
  return { workspace, role: 'owner' }
}

export async function listWorkspacesForUser(
  db: DbExecutor,
  userId: string,
): Promise<WorkspaceMembership[]> {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
  return rows.map(({ role, ...workspace }) => ({ workspace, role }))
}

/** The tenant check: the workspace as seen by `userId`, or undefined if not a member. */
export async function findMembership(
  db: DbExecutor,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMembership | undefined> {
  const [row] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
  if (!row) return undefined
  const { role, ...workspace } = row
  return { workspace, role }
}

/** Serializes membership changes of one workspace (last-owner checks race otherwise). */
export async function lockWorkspace(db: DbExecutor, workspaceId: string): Promise<void> {
  await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update')
}

export async function listMembers(db: DbExecutor, workspaceId: string) {
  return db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt), asc(users.id))
}

export type InsertMemberResult = { ok: true } | { ok: false; reason: 'already-member' }

export async function insertMember(
  db: DbExecutor,
  input: { workspaceId: string; userId: string; role: WorkspaceRole },
): Promise<InsertMemberResult> {
  try {
    await db.insert(workspaceMembers).values(input)
    return { ok: true }
  } catch (error) {
    if (isUniqueViolation(error, 'workspace_members_workspace_id_user_id_pk')) {
      return { ok: false, reason: 'already-member' }
    }
    throw error
  }
}

export async function updateMemberRole(
  db: DbExecutor,
  input: { workspaceId: string; userId: string; role: WorkspaceRole },
): Promise<void> {
  await db
    .update(workspaceMembers)
    .set({ role: input.role })
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userId, input.userId),
      ),
    )
}

export async function deleteMember(
  db: DbExecutor,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
}

export async function countOwners(db: DbExecutor, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ owners: count() })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')))
  return row?.owners ?? 0
}
