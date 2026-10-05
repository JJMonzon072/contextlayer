import {
  guidePublishPath,
  guideRestorePath,
  guideSchema,
  guideListSchema,
  guidesPath,
  guideStepsPath,
  guideVersionListSchema,
  guideVersionSchema,
  guideVersionsPath,
  publishGuideResponseSchema,
  type CreateGuideRequest,
  type Guide,
  type GuideList,
  type GuideStatus,
  type GuideVersion,
  type GuideVersionSummary,
  type PublishGuideResponse,
  type ReplaceStepsRequest,
  type UpdateGuideRequest,
} from '@contextlayer/shared'

import { request } from '../../lib/http'

const withSignal = (signal: AbortSignal | undefined) => (signal ? { signal } : {})

export function listGuides(
  workspaceId: string,
  filter: {
    applicationId?: string
    status?: GuideStatus
    cursor?: string | undefined
    limit?: number
    signal?: AbortSignal
  } = {},
): Promise<GuideList> {
  const query = new URLSearchParams()
  if (filter.applicationId !== undefined) query.set('applicationId', filter.applicationId)
  if (filter.status !== undefined) query.set('status', filter.status)
  if (filter.limit !== undefined) query.set('limit', String(filter.limit))
  if (filter.cursor !== undefined) query.set('cursor', filter.cursor)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  return request('GET', `${guidesPath(workspaceId)}${suffix}`, {
    schema: guideListSchema,
    ...withSignal(filter.signal),
  })
}

export function getGuide(
  workspaceId: string,
  guideId: string,
  signal?: AbortSignal,
): Promise<Guide> {
  return request('GET', guidesPath(workspaceId, guideId), {
    schema: guideSchema,
    ...withSignal(signal),
  })
}

export function createGuide(workspaceId: string, body: CreateGuideRequest): Promise<Guide> {
  return request('POST', guidesPath(workspaceId), { body, schema: guideSchema })
}

export function updateGuide(
  workspaceId: string,
  guideId: string,
  body: UpdateGuideRequest,
): Promise<Guide> {
  return request('PATCH', guidesPath(workspaceId, guideId), { body, schema: guideSchema })
}

export function replaceSteps(
  workspaceId: string,
  guideId: string,
  body: ReplaceStepsRequest,
): Promise<Guide> {
  return request('PUT', guideStepsPath(workspaceId, guideId), { body, schema: guideSchema })
}

export function publishGuide(workspaceId: string, guideId: string): Promise<PublishGuideResponse> {
  return request('POST', guidePublishPath(workspaceId, guideId), {
    schema: publishGuideResponseSchema,
  })
}

export function archiveGuide(workspaceId: string, guideId: string): Promise<undefined> {
  return request('DELETE', guidesPath(workspaceId, guideId))
}

export function restoreGuide(workspaceId: string, guideId: string): Promise<Guide> {
  return request('POST', guideRestorePath(workspaceId, guideId), { schema: guideSchema })
}

export async function listVersions(
  workspaceId: string,
  guideId: string,
  signal?: AbortSignal,
): Promise<GuideVersionSummary[]> {
  const list = await request('GET', guideVersionsPath(workspaceId, guideId), {
    schema: guideVersionListSchema,
    ...withSignal(signal),
  })
  return list.items
}

export function getVersion(
  workspaceId: string,
  guideId: string,
  version: number,
  signal?: AbortSignal,
): Promise<GuideVersion> {
  return request('GET', guideVersionsPath(workspaceId, guideId, version), {
    schema: guideVersionSchema,
    ...withSignal(signal),
  })
}
