import { z } from 'zod'

import { EXTENSION_ID_PATTERN } from './extension-identity.js'
import { pageQuerySchema, pageSchema } from './pagination.js'
import { guideSnapshotSchema } from './guides.js'

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
