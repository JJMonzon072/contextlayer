/**
 * Message protocol between the extension contexts.
 *
 *   popup ──runtime.sendMessage──▶ background (service worker) ──fetch──▶ API
 *   content script ──runtime.sendMessage──▶ background
 *   popup / background ──tabs.sendMessage──▶ content script
 *
 * Every message crossing a context boundary is validated with zod on the
 * receiving side. Content scripts run inside untrusted pages, so the background
 * treats their messages as untrusted input.
 */
import {
  guideSchema,
  guideSummarySchema,
  guideTitleSchema,
  healthReportSchema,
  MAX_GUIDE_STEPS,
  publishedGuideSummarySchema,
  replaceStepsRequestSchema,
  richTextSchema,
  stepPlacementSchema,
  targetDescriptorSchema,
  urlPatternSchema,
} from '@contextlayer/shared'
import { z } from 'zod'

import { MESSAGE_ERROR_CODES } from './result'

export { failure, MESSAGE_ERROR_CODES, success } from './result'
export type { MessageError, MessageResult } from './result'

export const messageErrorSchema = z.object({
  code: z.enum(MESSAGE_ERROR_CODES),
  message: z.string(),
})

/**
 * Responses are explicit results instead of thrown errors: exceptions do not
 * cross `chrome.runtime` message boundaries in a useful way.
 */
export function messageResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: messageErrorSchema }),
  ])
}

// --- Requests handled by the background service worker ----------------------

/** How long the page waits for a click once the side panel asked for a target. */
export const PICKER_TTL_MS = 120_000

/** What a step preview shows on the page: its title and its instructions as lines of text. */
export const PREVIEW_MAX_LINES = 40
export const previewTextSchema = {
  title: z.string().max(120),
  lines: z.array(z.string().max(2_000)).max(PREVIEW_MAX_LINES),
}

/** One capture request, created by the worker; a content script answers only that one. */
export const captureIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
/** The side panel that owns the Edit Mode session, issued by the worker on attach. */
export const panelIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
/** Chosen by the panel for one save, echoed back so it can tell answers apart. */
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)

/**
 * A step as the side panel edits it: the title may still be empty, and the
 * fields the panel does not edit (`urlPattern`, `placement`) are kept as
 * loaded, so saving from Edit Mode never drops what the dashboard set.
 */
export const draftStepSchema = z.strictObject({
  id: z.uuid().nullable(),
  title: z.string().max(120),
  body: richTextSchema,
  target: targetDescriptorSchema.nullable(),
  urlPattern: urlPatternSchema.nullable(),
  placement: stepPlacementSchema,
})

export type DraftStep = z.infer<typeof draftStepSchema>

/** The unsaved steps of one guide, kept in `storage.session` until saved or discarded. */
export const localDraftInputSchema = z.strictObject({
  applicationId: z.uuid(),
  guideId: z.uuid(),
  /** The revision the edits started from. */
  baseRevision: z.number().int().min(1),
  steps: z.array(draftStepSchema).max(MAX_GUIDE_STEPS),
})

export type LocalDraftInput = z.infer<typeof localDraftInputSchema>

const panel = { panelId: panelIdSchema }

export const backgroundRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('api.health.get') }),
  // Privileged: extension pages only (see ALLOWED_SENDERS in the worker).
  z.strictObject({ type: z.literal('connection.status') }),
  z.strictObject({ type: z.literal('connection.start') }),
  z.strictObject({ type: z.literal('connection.cancel') }),
  z.strictObject({ type: z.literal('connection.disconnect') }),
  z.strictObject({ type: z.literal('applications.list') }),
  z.strictObject({ type: z.literal('site.status'), tabId: z.number().int().nonnegative() }),
  // "Turn on": sent from the click, before Chrome's prompt; the worker completes it.
  z.strictObject({
    type: z.literal('site.requestActivation'),
    tabId: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('site.cancelActivation'), intentId: z.string().min(1) }),
  z.strictObject({ type: z.literal('site.disable'), tabId: z.number().int().nonnegative() }),
  // Edit Mode: the side panel only (see ALLOWED_SENDERS in the router).
  z.strictObject({ type: z.literal('authoring.attach'), tabId: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('authoring.state'), ...panel }),
  z.strictObject({ type: z.literal('authoring.guides'), ...panel, applicationId: z.uuid() }),
  z.strictObject({
    type: z.literal('authoring.open'),
    ...panel,
    applicationId: z.uuid(),
    guideId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('authoring.create'),
    ...panel,
    applicationId: z.uuid(),
    title: guideTitleSchema,
  }),
  z.strictObject({ type: z.literal('authoring.resume'), ...panel }),
  z.strictObject({ type: z.literal('authoring.capture.start'), ...panel }),
  z.strictObject({ type: z.literal('authoring.capture.cancel'), ...panel }),
  z.strictObject({
    type: z.literal('authoring.capture.take'),
    ...panel,
    captureId: captureIdSchema,
  }),
  z.strictObject({
    type: z.literal('authoring.save'),
    ...panel,
    operationId: operationIdSchema,
    applicationId: z.uuid(),
    guideId: z.uuid(),
    request: replaceStepsRequestSchema,
  }),
  z.strictObject({
    type: z.literal('authoring.local.write'),
    ...panel,
    draft: localDraftInputSchema,
  }),
  z.strictObject({ type: z.literal('authoring.local.clear'), ...panel, guideId: z.uuid() }),
  z.strictObject({
    type: z.literal('authoring.preview.show'),
    ...panel,
    captureId: captureIdSchema,
    ...previewTextSchema,
  }),
  z.strictObject({ type: z.literal('authoring.preview.hide'), ...panel }),
  z.strictObject({ type: z.literal('authoring.exit'), ...panel }),
  // Best effort from the panel's pagehide: the panel is closing.
  z.strictObject({ type: z.literal('authoring.detach'), ...panel }),
  // What a content script may send: "may I run on this page?", and the answer
  // to the capture the worker asked it for (checked against the session).
  z.strictObject({ type: z.literal('page.hello') }),
  z.strictObject({
    type: z.literal('picker.result'),
    captureId: captureIdSchema,
    // Validated against the shared TargetDescriptor schema by the worker.
    outcome: z.discriminatedUnion('ok', [
      z.strictObject({ ok: z.literal(true), descriptor: z.unknown() }),
      z.strictObject({ ok: z.literal(false), reason: z.string().max(200) }),
    ]),
  }),
  z.strictObject({
    type: z.literal('picker.cancelled'),
    captureId: captureIdSchema,
    reason: z.enum(['escape', 'timeout']),
  }),
])

export type BackgroundRequest = z.infer<typeof backgroundRequestSchema>

export const apiHealthResultSchema = messageResultSchema(healthReportSchema)

/** Public facts only: never a token, a verifier or a code. */
export const connectionStatusSchema = z.object({
  state: z.enum(['disconnected', 'connecting', 'connected', 'ended']),
  connection: z
    .object({
      id: z.string(),
      label: z.string(),
      user: z.object({ displayName: z.string(), email: z.string() }),
      workspace: z.object({ id: z.string(), name: z.string() }),
      createdAt: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
  attemptPending: z.boolean(),
  persistent: z.boolean(),
  /** `withheld`: the user turned off the extension's access to the API origin in Chrome. */
  api: z.enum(['ok', 'unreachable', 'withheld']),
})

export type ConnectionStatusData = z.infer<typeof connectionStatusSchema>

export const connectionStatusResultSchema = messageResultSchema(connectionStatusSchema)

export const disconnectResultSchema = messageResultSchema(
  z.object({ serverConfirmed: z.boolean() }),
)

const siteFields = {
  origin: z.string(),
  pattern: z.string(),
  /** Names of the workspace's applications registered for this origin. */
  applications: z.array(z.string()),
}

/** What the popup shows for the active tab's site (ADR 0017). */
export const siteStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unsupported') }),
  z.object({ state: z.literal('disconnected'), origin: z.string() }),
  z.object({ state: z.literal('api-withheld'), origin: z.string() }),
  z.object({ state: z.literal('api-unreachable'), origin: z.string() }),
  z.object({ state: z.literal('not-registered'), origin: z.string(), workspace: z.string() }),
  z.object({
    state: z.literal('available'),
    ...siteFields,
    permission: z.enum(['granted', 'missing']),
  }),
  z.object({ state: z.literal('permission-missing'), ...siteFields }),
  z.object({
    state: z.literal('active'),
    ...siteFields,
    /** `null` when the API could not be reached. */
    guides: z.array(publishedGuideSummarySchema).nullable(),
    moreGuides: z.boolean(),
  }),
])

export type SiteStatusData = z.infer<typeof siteStatusSchema>

export const siteStatusResultSchema = messageResultSchema(siteStatusSchema)

export const helloResultSchema = messageResultSchema(z.object({ active: z.boolean() }))

/** `intentId` is null when nothing could be requested (no connection, no http(s) page). */
export const activationRequestResultSchema = messageResultSchema(
  z.object({ intentId: z.string().nullable() }),
)

export const activationCancelResultSchema = messageResultSchema(
  z.object({ cancelled: z.boolean() }),
)

/** The connection's applications, each origin marked on when ContextLayer runs there. */
export const applicationListSchema = z.object({
  /** `null` when not connected, or when the API cannot be reached and nothing is cached. */
  applications: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        origins: z.array(z.object({ origin: z.string(), on: z.boolean() })),
      }),
    )
    .nullable(),
})

export type ApplicationListData = z.infer<typeof applicationListSchema>

export const applicationListResultSchema = messageResultSchema(applicationListSchema)

// --- Edit Mode (side panel) ---------------------------------------------------

export const AUTHORING_END_REASONS = [
  'disconnected',
  'connection-changed',
  'site-off',
  'tab-closed',
  'moved',
  'exited',
  'closed',
] as const

export const authoringAttachSchema = z.object({
  panelId: panelIdSchema,
  workspace: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ displayName: z.string() }),
  origin: z.string(),
  /** The workspace's applications registered for this page's origin. */
  applications: z.array(z.object({ id: z.uuid(), name: z.string() })).min(1),
})

export type AuthoringAttachData = z.infer<typeof authoringAttachSchema>

export const CAPTURE_STATES = ['pending', 'done', 'failed', 'cancelled', 'expired'] as const

export const authoringStateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('active'),
    /** Set when the page was reloaded or left: capture waits for an explicit "continue". */
    paused: z.enum(['navigated', 'page-gone']).nullable(),
    guide: z.object({ applicationId: z.uuid(), guideId: z.uuid() }).nullable(),
    capture: z
      .object({ id: captureIdSchema, state: z.enum(CAPTURE_STATES), reason: z.string().nullable() })
      .nullable(),
  }),
  z.object({ state: z.literal('ended'), reason: z.enum(AUTHORING_END_REASONS) }),
])

export type AuthoringStateData = z.infer<typeof authoringStateSchema>

/** The local copy of unsaved steps, returned only to the same connection and guide. */
export const localDraftSchema = localDraftInputSchema.extend({ savedAt: z.number() })

export type LocalDraft = z.infer<typeof localDraftSchema>

export const authoringGuideSchema = z.object({
  guide: guideSchema,
  local: localDraftSchema.nullable(),
})

export const authoringCaptureSchema = z.object({
  id: captureIdSchema,
  state: z.enum(CAPTURE_STATES),
  descriptor: targetDescriptorSchema.nullable(),
  reason: z.string().nullable(),
})

export type AuthoringCaptureData = z.infer<typeof authoringCaptureSchema>

export const authoringStateResultSchema = messageResultSchema(authoringStateSchema)
export const authoringAttachResultSchema = messageResultSchema(authoringAttachSchema)
export const authoringGuidesResultSchema = messageResultSchema(
  z.object({ items: z.array(guideSummarySchema) }),
)
export const authoringGuideResultSchema = messageResultSchema(authoringGuideSchema)
export const authoringCaptureStartResultSchema = messageResultSchema(
  z.object({ captureId: captureIdSchema }),
)
export const authoringCaptureResultSchema = messageResultSchema(authoringCaptureSchema)
export const authoringSaveResultSchema = messageResultSchema(
  z.object({ operationId: operationIdSchema, guide: guideSchema }),
)
export const authoringLocalResultSchema = messageResultSchema(
  z.object({ stored: z.boolean(), reason: z.enum(['too-large', 'quota']).nullable() }),
)
export const authoringDoneResultSchema = messageResultSchema(z.object({ done: z.boolean() }))
/** `shown: false`: this page no longer holds that element (reloaded, removed, never selected here). */
export const previewResultSchema = messageResultSchema(z.object({ shown: z.boolean() }))

/**
 * Worker → side panel: "the Edit Mode session changed, ask again". Data-less,
 * like `connection.changed`: content scripts can message extension pages too,
 * so a forged copy can at most trigger a state refresh.
 */
export const AUTHORING_CHANGED = { type: 'authoring.changed' } as const

/**
 * Worker → extension pages: "the connection changed, ask again". Carries no
 * data, so a forged copy (content scripts can message extension pages) can at
 * most trigger a status refresh.
 */
export const CONNECTION_CHANGED = { type: 'connection.changed' } as const

// --- Requests handled by the content script ----------------------------------

export const contentRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('page.ping') }),
  // Sent by the worker when the site lost access: the script stops for good.
  z.strictObject({ type: z.literal('page.deactivate') }),
  // Worker only: let the author pick an element, for this capture request.
  z.strictObject({
    type: z.literal('picker.start'),
    captureId: captureIdSchema,
    ttlMs: z.number().int().min(1_000).max(PICKER_TTL_MS),
  }),
  z.strictObject({ type: z.literal('picker.stop'), captureId: captureIdSchema }),
  // Worker only: highlight the element selected under this request, with the step's text.
  z.strictObject({
    type: z.literal('preview.show'),
    captureId: captureIdSchema,
    ...previewTextSchema,
  }),
  z.strictObject({ type: z.literal('preview.hide') }),
])

export type ContentRequest = z.infer<typeof contentRequestSchema>

export const pageInfoSchema = z.object({
  url: z.string(),
  title: z.string(),
  extensionVersion: z.string(),
})

export type PageInfo = z.infer<typeof pageInfoSchema>

export const pageInfoResultSchema = messageResultSchema(pageInfoSchema)
