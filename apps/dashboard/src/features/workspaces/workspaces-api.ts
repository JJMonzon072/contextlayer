import {
  memberListSchema,
  memberSchema,
  workspaceMembersPath,
  WORKSPACES_PATH,
  workspaceSummarySchema,
  type AddMemberRequest,
  type Member,
  type WorkspaceRole,
  type WorkspaceSummary,
} from '@contextlayer/shared'

import { request } from '../../lib/http'

export function createWorkspace(name: string): Promise<WorkspaceSummary> {
  return request('POST', WORKSPACES_PATH, { body: { name }, schema: workspaceSummarySchema })
}

export async function listMembers(workspaceId: string, signal?: AbortSignal): Promise<Member[]> {
  const list = await request('GET', workspaceMembersPath(workspaceId), {
    schema: memberListSchema,
    ...(signal && { signal }),
  })
  return list.items
}

export function addMember(workspaceId: string, body: AddMemberRequest): Promise<Member> {
  return request('POST', workspaceMembersPath(workspaceId), { body, schema: memberSchema })
}

export function changeMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<Member> {
  return request('PATCH', workspaceMembersPath(workspaceId, userId), {
    body: { role },
    schema: memberSchema,
  })
}

export function removeMember(workspaceId: string, userId: string): Promise<undefined> {
  return request('DELETE', workspaceMembersPath(workspaceId, userId))
}
