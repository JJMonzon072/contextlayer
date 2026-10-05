import type { ApiClient } from './api-client'
import { createAuth } from './auth'
import { createConnectionManager } from './connection'
import { createLifecycle } from './lifecycle'
import type { ExtensionStorage } from './storage'
import { createVault } from './vault'

/**
 * The worker's connection pieces, wired once around one life cycle; `index.ts`
 * adds the Chrome listeners, tests use it with fakes.
 */
export function createWorkerCore(deps: {
  storage: ExtensionStorage
  api: ApiClient
  now: () => number
  openTab: (url: string) => Promise<number | undefined>
  apiAccess: () => Promise<boolean>
  dashboardOrigin: string
  extensionId: string
  onChanged: () => Promise<void>
}) {
  const vault = createVault(deps.storage)
  const lifecycle = createLifecycle()
  const auth = createAuth({
    vault,
    api: deps.api,
    lifecycle,
    now: deps.now,
    onEnded: deps.onChanged,
  })
  const connection = createConnectionManager({ ...deps, vault, auth, lifecycle })
  return { vault, lifecycle, auth, connection }
}
