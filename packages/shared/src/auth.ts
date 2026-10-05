import { z } from 'zod'

import { workspaceSummarySchema } from './workspaces.js'

export const AUTH_PATHS = {
  register: '/v1/auth/register',
  login: '/v1/auth/login',
  logout: '/v1/auth/logout',
  session: '/v1/auth/session',
} as const

/** Passwords are length-checked only (NIST SP 800-63B): no composition rules. */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

/**
 * Emails are trimmed but keep the user's casing; uniqueness and lookups are
 * case-insensitive in the database (`lower(email)`, see docs/data-model.md).
 */
export const emailSchema = z.string().trim().max(254).pipe(z.email())

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  displayName: z.string().trim().min(1).max(80),
})

/** Login only bounds sizes: telling users the email format is wrong would add nothing. */
export const loginRequestSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})

export const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  createdAt: z.iso.datetime(),
})

/** Body of register, login and `GET /v1/auth/session`. Never carries tokens or hashes. */
export const sessionResponseSchema = z.object({
  user: userSchema,
  workspaces: z.array(workspaceSummarySchema),
})

export type RegisterRequest = z.infer<typeof registerRequestSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
export type User = z.infer<typeof userSchema>
export type SessionResponse = z.infer<typeof sessionResponseSchema>
