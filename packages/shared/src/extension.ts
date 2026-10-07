import { z } from 'zod'

import { EXTENSION_ID_PATTERN } from './extension-identity.js'
import { pageQuerySchema, pageSchema } from './pagination.js'
import { guideSnapshotSchema, guideTitleSchema } from './guides.js'
import { urlPatternSchema } from './url-pattern.js'

/**
 * Extension connection (ADR 0015): the dashboard issues a one-time code bound to
 * a PKCE S256 challenge; the extension's service worker exchanges it for an
 * opaque access token and a rotating refresh token tied to one workspace.
 *
 * Authentication per route:
 * - `codes`, `connections`: dashboard session cookie + CSRF guard.
 * - `token`: the code or refresh token in the body; no cookie, no bearer.
 * - `revoke`, `session`, `applications`, `guides`: `Authorization: Bearer <access token>`.
 */
export const EXTENSION_PATHS = {
  codes: '/v1/extension/codes',
  token: '/v1/extension/token',
  revoke: '/v1/extension/revoke',
  session: '/v1/extension/session',
  connections: '/v1/extension/connections',
  applications: '/v1/extension/applications',
  guides: '/v1/extension/guides',
} as const

export const extensionConnectionPath = (connectionId: string) =>
  `${EXTENSION_PATHS.connections}/${connectionId}`
export const extensionGuidePath = (guideId: string) => `${EXTENSION_PATHS.guides}/${guideId}`

/**
 * Guide authoring from the extension's side panel (Phase 5, bearer only):
 * the editable guides of one application of the grant's workspace, their
 * drafts and the replacement of their steps. Editors and above; members get
 * 403. Responses reuse the dashboard's guide contracts.
 */
export const EXTENSION_AUTHORING_PATH = '/v1/extension/authoring'
export const extensionAuthoringGuidesPath = (applicationId: string) =>
  `${EXTENSION_AUTHORING_PATH}/applications/${applicationId}/guides`
export const extensionAuthoringGuidePath = (applicationId: string, guideId: string) =>
  `${extensionAuthoringGuidesPath(applicationId)}/${guideId}`
export const extensionAuthoringStepsPath = (applicationId: string, guideId: string) =>
  `${extensionAuthoringGuidePath(applicationId, guideId)}/steps`

/** A guide created from the side panel: a title; the rest is edited in the dashboard. */
export const authoringCreateGuideRequestSchema = z.strictObject({ title: guideTitleSchema })

/** Opaque credentials: a type prefix and 256 random bits in base64url. */
export const CREDENTIAL_PREFIXES = { code: 'clc_', access: 'cla_', refresh: 'clr_' } as const
export type CredentialKind = keyof typeof CREDENTIAL_PREFIXES

export function credentialPattern(kind: CredentialKind): RegExp {
  return new RegExp(`^${CREDENTIAL_PREFIXES[kind]}[A-Za-z0-9_-]{43}$`)
}

const credential = (kind: CredentialKind) => z.string().regex(credentialPattern(kind))

/** BASE64URL(SHA-256(verifier)), RFC 7636: 43 characters. */
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** RFC 7636 unreserved characters, 43 to 128 of them. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/
/** The extension's `state`: 256 random bits in base64url. */
export const CONNECTION_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/

export const CONNECTION_CODE_TTL_SECONDS = 60

export const connectionLabelSchema = z.string().trim().min(1).max(60)

export const createConnectionCodeRequestSchema = z.strictObject({
  workspaceId: z.uuid(),
  codeChallenge: z.string().regex(PKCE_CHALLENGE_PATTERN),
  /** Only S256: a `plain` challenge would put the verifier itself in the URL. */
  codeChallengeMethod: z.literal('S256'),
  label: connectionLabelSchema.optional(),
})

export const connectionCodeSchema = z.object({
  code: credential('code'),
  expiresAt: z.iso.datetime(),
})

export const extensionTokenRequestSchema = z.discriminatedUnion('grantType', [
  z.strictObject({
    grantType: z.literal('authorization_code'),
    code: credential('code'),
    codeVerifier: z.string().regex(PKCE_VERIFIER_PATTERN),
    clientId: z.string().regex(EXTENSION_ID_PATTERN),
  }),
  z.strictObject({
    grantType: z.literal('refresh_token'),
    refreshToken: credential('refresh'),
  }),
])

/** Public facts about a connection, safe to show in the popup (no credentials). */
export const extensionConnectionInfoSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  user: z.object({ displayName: z.string(), email: z.string() }),
  workspace: z.object({ id: z.uuid(), name: z.string() }),
})

export const extensionTokenResponseSchema = z.object({
  accessToken: credential('access'),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: credential('refresh'),
  connection: extensionConnectionInfoSchema,
})

export const GRANT_REVOCATION_REASONS = [
  /** The extension disconnected itself. */
  'disconnected',
  /** Revoked by its owner from "Connected browsers". */
  'dashboard',
  /** A used refresh token was presented again. */
  'refresh-reuse',
  /** A consumed connection code was presented again. */
  'code-replay',
  /** The extension connected again, replacing this connection. */
  'replaced',
] as const

export const CONNECTION_STATUSES = ['active', 'expired', 'revoked'] as const

/** A connection as its owner sees it in the dashboard. */
export const connectionSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  workspace: z.object({ id: z.uuid(), name: z.string() }),
  status: z.enum(CONNECTION_STATUSES),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedReason: z.enum(GRANT_REVOCATION_REASONS).nullable(),
})

export const connectionListSchema = z.object({ items: z.array(connectionSchema) })

// --- Dashboard → extension handoff (externally_connectable) -------------------

/**
 * The only messages the dashboard may send the extension. The extension checks
 * the sender (exact dashboard origin, top frame, the tab it opened) and the
 * pending attempt's `state` before acting; the code alone is useless without
 * the PKCE verifier that never left the service worker.
 */
export const extensionExternalMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('connection.complete'),
    state: z.string().regex(CONNECTION_STATE_PATTERN),
    code: credential('code'),
  }),
  z.strictObject({
    type: z.literal('connection.cancel'),
    state: z.string().regex(CONNECTION_STATE_PATTERN),
  }),
])

export const EXTERNAL_ERROR_CODES = [
  /** Malformed message or a sender that is not the expected dashboard tab. */
  'invalid-request',
  /** No pending attempt with this state (finished, replaced, cancelled). */
  'unknown-attempt',
  'expired-attempt',
  /** The API refused the code (expired, used, wrong verifier). */
  'exchange-failed',
  'api-unreachable',
] as const

/** Acknowledgement to the dashboard: never a token, only who is now connected. */
export const extensionExternalResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    connection: z
      .object({
        user: z.object({ displayName: z.string() }),
        workspace: z.object({ name: z.string() }),
      })
      .nullable(),
  }),
  z.object({ ok: z.literal(false), error: z.enum(EXTERNAL_ERROR_CODES) }),
])

/** Why a connection was revoked from the extension itself. */
export const extensionRevokeRequestSchema = z.strictObject({
  reason: z.enum(['disconnected', 'replaced']).default('disconnected'),
})

// --- Published content for a connection --------------------------------------

export const extensionApplicationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  origins: z.array(z.string()),
})

export const extensionApplicationListSchema = z.object({
  items: z.array(extensionApplicationSchema),
})

/** Discovery is by exact origin: guides published for that application, newest first. */
export const publishedGuideQuerySchema = pageQuerySchema.extend({
  origin: z.string().min(1).max(300),
})

/** A light summary; the snapshot is only sent by the detail endpoint. */
export const publishedGuideSummarySchema = z.object({
  guideId: z.uuid(),
  applicationId: z.uuid(),
  version: z.number().int().min(1),
  title: z.string(),
  description: z.string(),
  stepCount: z.number().int().min(0),
  publishedAt: z.iso.datetime(),
  /**
   * The published version's start page, matched by the extension against the
   * current page (the API only narrows by origin); `null`: any page of the origin.
   */
  startUrlPattern: urlPatternSchema.nullable(),
})

export const publishedGuideListSchema = pageSchema(publishedGuideSummarySchema)

export const publishedGuideSchema = z.object({
  guideId: z.uuid(),
  applicationId: z.uuid(),
  version: z.number().int().min(1),
  publishedAt: z.iso.datetime(),
  snapshot: guideSnapshotSchema,
})

export type CreateConnectionCodeRequest = z.infer<typeof createConnectionCodeRequestSchema>
export type ConnectionCode = z.infer<typeof connectionCodeSchema>
export type ExtensionTokenRequest = z.infer<typeof extensionTokenRequestSchema>
export type ExtensionTokenResponse = z.infer<typeof extensionTokenResponseSchema>
export type ExtensionConnectionInfo = z.infer<typeof extensionConnectionInfoSchema>
export type GrantRevocationReason = (typeof GRANT_REVOCATION_REASONS)[number]
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]
export type Connection = z.infer<typeof connectionSchema>
export type ExtensionApplication = z.infer<typeof extensionApplicationSchema>
export type PublishedGuideSummary = z.infer<typeof publishedGuideSummarySchema>
export type PublishedGuideList = z.infer<typeof publishedGuideListSchema>
export type PublishedGuide = z.infer<typeof publishedGuideSchema>
export type ExtensionExternalMessage = z.infer<typeof extensionExternalMessageSchema>
export type ExtensionExternalResponse = z.infer<typeof extensionExternalResponseSchema>
export type ExternalErrorCode = (typeof EXTERNAL_ERROR_CODES)[number]
export type AuthoringCreateGuideRequest = z.infer<typeof authoringCreateGuideRequestSchema>
