import { z } from 'zod'

import { pageQuerySchema, pageSchema } from './pagination.js'
import { richTextSchema } from './rich-text.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { urlPatternSchema } from './url-pattern.js'
import { workspacePath } from './workspaces.js'

/**
 * - `draft`: never published.
 * - `published`: at least one immutable version exists; the draft rows stay
 *   editable and `hasUnpublishedChanges` says whether they differ from the
 *   latest version.
 * - `archived`: read-only and hidden from players; its versions are kept.
 */
export const GUIDE_STATUSES = ['draft', 'published', 'archived'] as const
export const STEP_PLACEMENTS = ['auto', 'top', 'right', 'bottom', 'left'] as const
export const MAX_GUIDE_STEPS = 50

export function guidesPath(workspaceId: string, guideId?: string): string {
  const guides = `${workspacePath(workspaceId)}/guides`
  return guideId === undefined ? guides : `${guides}/${guideId}`
}

export const guideStepsPath = (workspaceId: string, guideId: string) =>
  `${guidesPath(workspaceId, guideId)}/steps`
export const guidePublishPath = (workspaceId: string, guideId: string) =>
  `${guidesPath(workspaceId, guideId)}/publish`
export const guideRestorePath = (workspaceId: string, guideId: string) =>
  `${guidesPath(workspaceId, guideId)}/restore`
export function guideVersionsPath(workspaceId: string, guideId: string, version?: number): string {
  const versions = `${guidesPath(workspaceId, guideId)}/versions`
  return version === undefined ? versions : `${versions}/${String(version)}`
}

export const guideStatusSchema = z.enum(GUIDE_STATUSES)
export const stepPlacementSchema = z.enum(STEP_PLACEMENTS)
export const guideTitleSchema = z.string().trim().min(1).max(120)
export const guideDescriptionSchema = z.string().trim().max(500)
export const stepTitleSchema = z.string().trim().min(1).max(120)
const revisionSchema = z.number().int().min(1)

/** `target: null` means not captured yet (Edit Mode, Phase 5) or an unanchored step. */
export const guideStepSchema = z.object({
  id: z.uuid(),
  position: z.number().int().min(0),
  title: z.string(),
  body: richTextSchema,
  target: targetDescriptorSchema.nullable(),
  urlPattern: urlPatternSchema.nullable(),
  placement: stepPlacementSchema,
})

export const guideSummarySchema = z.object({
  id: z.uuid(),
  applicationId: z.uuid(),
  title: z.string(),
  description: z.string(),
  status: guideStatusSchema,
  /** Increases on every draft change; send it back as `expectedRevision`. */
  revision: revisionSchema,
  stepCount: z.number().int().min(0),
  /** Number of the latest published version, `null` if never published. */
  latestVersion: z.number().int().min(1).nullable(),
  hasUnpublishedChanges: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
})

export const guideSchema = guideSummarySchema.extend({
  startUrlPattern: urlPatternSchema.nullable(),
  steps: z.array(guideStepSchema),
})

export const guideListSchema = pageSchema(guideSummarySchema)

/** Without `status`, archived guides are left out. */
export const guideListQuerySchema = pageQuerySchema.extend({
  applicationId: z.uuid().optional(),
  status: guideStatusSchema.optional(),
})

export const createGuideRequestSchema = z.strictObject({
  applicationId: z.uuid(),
  title: guideTitleSchema,
  description: guideDescriptionSchema.optional(),
  startUrlPattern: urlPatternSchema.nullable().optional(),
})

export const updateGuideRequestSchema = z
  .strictObject({
    title: guideTitleSchema.optional(),
    description: guideDescriptionSchema.optional(),
    startUrlPattern: urlPatternSchema.nullable().optional(),
    /** When present, the update is refused (409) if the guide changed since. */
    expectedRevision: revisionSchema.optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.startUrlPattern !== undefined,
    { message: 'Change the title, the description or the start page.' },
  )

/** A step without `id` is new; an existing step keeps its id across reorders. */
export const stepInputSchema = z.strictObject({
  id: z.uuid().optional(),
  title: stepTitleSchema,
  body: richTextSchema,
  target: targetDescriptorSchema.nullable().optional(),
  urlPattern: urlPatternSchema.nullable().optional(),
  placement: stepPlacementSchema.optional(),
})

/**
 * Replaces the whole ordered list in one transaction: the array order is the
 * position (0, 1, 2…), so positions can never collide or leave gaps.
 */
export const replaceStepsRequestSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    steps: z
      .array(stepInputSchema)
      .max(MAX_GUIDE_STEPS, `A guide can have at most ${String(MAX_GUIDE_STEPS)} steps.`),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.steps.forEach((step, index) => {
      if (step.id === undefined) return
      if (seen.has(step.id)) {
        ctx.addIssue({ code: 'custom', message: 'A step appears twice.', path: ['steps', index] })
      }
      seen.add(step.id)
    })
  })

/** The frozen content of one published version (ADR 0016). */
export const guideSnapshotV1Schema = z.strictObject({
  version: z.literal(1),
  guide: z.strictObject({
    id: z.uuid(),
    applicationId: z.uuid(),
    title: z.string(),
    description: z.string(),
    startUrlPattern: urlPatternSchema.nullable(),
  }),
  steps: z
    .array(
      z.strictObject({
        id: z.uuid(),
        position: z.number().int().min(0),
        title: z.string(),
        body: richTextSchema,
        target: targetDescriptorSchema.nullable(),
        urlPattern: urlPatternSchema.nullable(),
        placement: stepPlacementSchema,
      }),
    )
    .min(1)
    .max(MAX_GUIDE_STEPS),
})

export const guideSnapshotSchema = z.discriminatedUnion('version', [guideSnapshotV1Schema])

export const guideVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  publishedAt: z.iso.datetime(),
  /** `null` once the publishing account is deleted. */
  publishedBy: z.object({ userId: z.uuid(), displayName: z.string() }).nullable(),
  stepCount: z.number().int().min(0),
})

export const guideVersionListSchema = z.object({ items: z.array(guideVersionSummarySchema) })

export const guideVersionSchema = guideVersionSummarySchema.extend({
  guideId: z.uuid(),
  snapshot: guideSnapshotSchema,
})

/** `created: false` means the draft had not changed: the latest version is returned. */
export const publishGuideResponseSchema = z.object({
  created: z.boolean(),
  version: guideVersionSummarySchema,
  guide: guideSummarySchema,
})

export type GuideStatus = z.infer<typeof guideStatusSchema>
export type StepPlacement = z.infer<typeof stepPlacementSchema>
export type GuideStep = z.infer<typeof guideStepSchema>
export type GuideSummary = z.infer<typeof guideSummarySchema>
export type Guide = z.infer<typeof guideSchema>
export type GuideList = z.infer<typeof guideListSchema>
export type GuideListQuery = z.infer<typeof guideListQuerySchema>
export type CreateGuideRequest = z.infer<typeof createGuideRequestSchema>
export type UpdateGuideRequest = z.infer<typeof updateGuideRequestSchema>
export type StepInput = z.infer<typeof stepInputSchema>
export type ReplaceStepsRequest = z.infer<typeof replaceStepsRequestSchema>
export type GuideSnapshot = z.infer<typeof guideSnapshotSchema>
export type GuideVersionSummary = z.infer<typeof guideVersionSummarySchema>
export type GuideVersion = z.infer<typeof guideVersionSchema>
export type PublishGuideResponse = z.infer<typeof publishGuideResponseSchema>
