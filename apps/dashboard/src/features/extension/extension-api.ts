import {
  connectionListSchema,
  EXTENSION_PATHS,
  extensionConnectionPath,
  type Connection,
} from '@contextlayer/shared'

import { request } from '../../lib/http'

export async function listConnections(signal?: AbortSignal): Promise<Connection[]> {
  const list = await request('GET', EXTENSION_PATHS.connections, {
    schema: connectionListSchema,
    ...(signal && { signal }),
  })
  return list.items
}

export function revokeConnection(connectionId: string): Promise<undefined> {
  return request('DELETE', extensionConnectionPath(connectionId))
}
