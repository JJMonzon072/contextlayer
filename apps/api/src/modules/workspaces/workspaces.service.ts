import type { WorkspaceSummary } from '@contextlayer/shared'

import type { DrizzleDatabase } from '../../infrastructure/database/client.js'
import { listWorkspacesForUser, type WorkspaceMembership } from './workspaces.repository.js'

export function toWorkspaceSummary({ workspace, role }: WorkspaceMembership): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    role,
    createdAt: workspace.createdAt.toISOString(),
  }
}

export type WorkspacesService = ReturnType<typeof createWorkspacesService>

export function createWorkspacesService(deps: { db: DrizzleDatabase }) {
  const { db } = deps

  return {
    async listForUser(userId: string): Promise<WorkspaceSummary[]> {
      return (await listWorkspacesForUser(db, userId)).map(toWorkspaceSummary)
    },
  }
}
