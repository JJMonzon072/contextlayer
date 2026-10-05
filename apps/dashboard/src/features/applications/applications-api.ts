import {
  applicationListSchema,
  applicationSchema,
  applicationsPath,
  type Application,
  type ApplicationList,
  type CreateApplicationRequest,
  type UpdateApplicationRequest,
} from '@contextlayer/shared'

import { request } from '../../lib/http'

export function listApplications(
  workspaceId: string,
  options: { cursor?: string | undefined; limit?: number; signal?: AbortSignal } = {},
): Promise<ApplicationList> {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.cursor !== undefined) query.set('cursor', options.cursor)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  return request('GET', `${applicationsPath(workspaceId)}${suffix}`, {
    schema: applicationListSchema,
    ...(options.signal && { signal: options.signal }),
  })
}

export function getApplication(
  workspaceId: string,
  applicationId: string,
  signal?: AbortSignal,
): Promise<Application> {
  return request('GET', applicationsPath(workspaceId, applicationId), {
    schema: applicationSchema,
    ...(signal && { signal }),
  })
}

export function createApplication(
  workspaceId: string,
  body: CreateApplicationRequest,
): Promise<Application> {
  return request('POST', applicationsPath(workspaceId), { body, schema: applicationSchema })
}

export function updateApplication(
  workspaceId: string,
  applicationId: string,
  body: UpdateApplicationRequest,
): Promise<Application> {
  return request('PATCH', applicationsPath(workspaceId, applicationId), {
    body,
    schema: applicationSchema,
  })
}

export function deleteApplication(workspaceId: string, applicationId: string): Promise<undefined> {
  return request('DELETE', applicationsPath(workspaceId, applicationId))
}
