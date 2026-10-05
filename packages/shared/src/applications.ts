import { z } from 'zod'

import { originListSchema } from './origins.js'
import { pageQuerySchema, pageSchema } from './pagination.js'
import { workspacePath } from './workspaces.js'

/** A web application a workspace trains people on, identified by its origins. */
export function applicationsPath(workspaceId: string, applicationId?: string): string {
  const applications = `${workspacePath(workspaceId)}/applications`
  return applicationId === undefined ? applications : `${applications}/${applicationId}`
}

export const applicationNameSchema = z.string().trim().min(1).max(80)

export const applicationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Normalized origins such as `https://crm.example.com`. */
  origins: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const applicationListSchema = pageSchema(applicationSchema)
export const applicationListQuerySchema = pageQuerySchema

/** Strict: unknown keys (an id, a workspace id) are rejected, not ignored. */
export const createApplicationRequestSchema = z.strictObject({
  name: applicationNameSchema,
  origins: originListSchema,
})

export const updateApplicationRequestSchema = z
  .strictObject({
    name: applicationNameSchema.optional(),
    origins: originListSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.origins !== undefined, {
    message: 'Change the name or the origins.',
  })

export type Application = z.infer<typeof applicationSchema>
export type ApplicationList = z.infer<typeof applicationListSchema>
export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>
export type UpdateApplicationRequest = z.infer<typeof updateApplicationRequestSchema>
