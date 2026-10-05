import { z } from 'zod'

/** Highest privilege first. Used by zod here and by the database `CHECK` constraint. */
export const WORKSPACE_ROLES = ['owner', 'admin', 'editor', 'member'] as const

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES)

export const WORKSPACES_PATH = '/v1/workspaces'

export function workspacePath(workspaceId: string): string {
  return `${WORKSPACES_PATH}/${workspaceId}`
}

export function workspaceMembersPath(workspaceId: string, userId?: string): string {
  const members = `${workspacePath(workspaceId)}/members`
  return userId === undefined ? members : `${members}/${userId}`
}

export const workspaceNameSchema = z.string().trim().min(1).max(80)

/** A workspace as seen by one member: `role` is the caller's role in it. */
export const workspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: workspaceRoleSchema,
  createdAt: z.iso.datetime(),
})

export const workspaceListSchema = z.object({
  items: z.array(workspaceSummarySchema),
})

export const createWorkspaceRequestSchema = z.object({
  name: workspaceNameSchema,
})

export const memberSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: workspaceRoleSchema,
  joinedAt: z.iso.datetime(),
})

export const memberListSchema = z.object({
  items: z.array(memberSchema),
})

/** Adds an existing user (invitations by email are out of scope in Phase 2). */
export const addMemberRequestSchema = z.object({
  email: z.string().trim().min(1).max(254),
  role: workspaceRoleSchema,
})

export const updateMemberRoleRequestSchema = z.object({
  role: workspaceRoleSchema,
})

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>
export type WorkspaceList = z.infer<typeof workspaceListSchema>
export type Member = z.infer<typeof memberSchema>
export type MemberList = z.infer<typeof memberListSchema>
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>
export type AddMemberRequest = z.infer<typeof addMemberRequestSchema>
export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequestSchema>

const ROLE_RANK: Record<WorkspaceRole, number> = { owner: 3, admin: 2, editor: 1, member: 0 }

/** `owner` > `admin` > `editor` > `member`; the API enforces, the dashboard mirrors. */
export function roleAtLeast(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}
