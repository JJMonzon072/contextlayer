import {
  AUTH_PATHS,
  sessionResponseSchema,
  type LoginRequest,
  type RegisterRequest,
  type SessionResponse,
} from '@contextlayer/shared'

import { request } from '../../lib/http'

export function register(body: RegisterRequest): Promise<SessionResponse> {
  return request('POST', AUTH_PATHS.register, { body, schema: sessionResponseSchema })
}

export function login(body: LoginRequest): Promise<SessionResponse> {
  return request('POST', AUTH_PATHS.login, { body, schema: sessionResponseSchema })
}

export function logout(): Promise<undefined> {
  return request('POST', AUTH_PATHS.logout)
}

export function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  return request('GET', AUTH_PATHS.session, {
    schema: sessionResponseSchema,
    ...(signal && { signal }),
  })
}
