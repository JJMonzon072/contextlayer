import type { WorkspaceSummary } from '@contextlayer/shared'
import { computed, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'

import { session } from '../auth/session'

/** The workspace named by the route, if the signed-in user is a member of it. */
export function useCurrentWorkspace(): ComputedRef<WorkspaceSummary | undefined> {
  const route = useRoute()
  return computed(() => {
    const id = route.params.workspaceId
    return session.workspaces.value.find((workspace) => workspace.id === id)
  })
}
