import {
  connectionCodeSchema,
  connectionListSchema,
  EXTENSION_PATHS,
  extensionConnectionPath,
  type Connection,
  type ConnectionCode,
  type CreateConnectionCodeRequest,
} from '@contextlayer/shared'

import { request } from '../../lib/http'

export async function listConnections(signal?: AbortSignal): Promise<Connection[]> {
  const list = await request('GET', EXTENSION_PATHS.connections, {
    schema: connectionListSchema,
    ...(signal && { signal }),
  })
  return list.items
}

/** A one-time code (60 s) for the extension that sent `codeChallenge`; it goes to the extension only. */
export function createConnectionCode(input: CreateConnectionCodeRequest): Promise<ConnectionCode> {
  return request('POST', EXTENSION_PATHS.codes, { schema: connectionCodeSchema, body: input })
}

export function revokeConnection(connectionId: string): Promise<undefined> {
  return request('DELETE', extensionConnectionPath(connectionId))
}
