import type { WorkspaceRole } from '@contextlayer/shared'

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  member: 'Member',
}

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: 'Full control, including ownership and member management.',
  admin: 'Manages members and every guide in the workspace.',
  editor: 'Creates and edits guides.',
  member: 'Follows the guides published in this workspace.',
}

/** Mirrors the API rules; the API still enforces them. */
export function canManageMembers(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin'
}
