import { randomBytes } from 'node:crypto'

import {
  DEVELOPMENT_EXTENSION_ID,
  extensionOrigin,
  extensionTokenResponseSchema,
  type ExtensionTokenResponse,
} from '@contextlayer/shared'
import { expect } from 'vitest'

import { pkceChallenge } from '../../../src/modules/extension/credentials.js'
import type { TestApp } from './app.js'

/** What the service worker generates for one connection attempt. */
export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: pkceChallenge(verifier) }
}

/** The dashboard asks for a code (cookie + same-origin request). */
export function issueCode(
  app: TestApp,
  cookie: string,
  workspaceId: string,
  challenge: string,
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/extension/codes',
    headers: { cookie, origin: 'http://localhost:5173' },
    payload: { workspaceId, codeChallenge: challenge, codeChallengeMethod: 'S256', ...extra },
  })
}

/** The service worker calls the token endpoint: Origin chrome-extension://<id>, no cookie. */
export function postToken(app: TestApp, payload: object, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/extension/token',
    headers: { origin: extensionOrigin(DEVELOPMENT_EXTENSION_ID), ...headers },
    payload,
  })
}

export function exchange(
  app: TestApp,
  code: string,
  verifier: string,
  clientId = DEVELOPMENT_EXTENSION_ID,
) {
  return postToken(app, { grantType: 'authorization_code', code, codeVerifier: verifier, clientId })
}

/** A full connection: code issued by the dashboard, exchanged by the extension. */
export async function connect(
  app: TestApp,
  cookie: string,
  workspaceId: string,
): Promise<ExtensionTokenResponse> {
  const { verifier, challenge } = pkcePair()
  const issued = await issueCode(app, cookie, workspaceId, challenge)
  expect(issued.statusCode, issued.body).toBe(201)
  const response = await exchange(app, issued.json<{ code: string }>().code, verifier)
  expect(response.statusCode, response.body).toBe(200)
  return extensionTokenResponseSchema.parse(response.json())
}

export function bearer(app: TestApp, url: string, token: string, method: 'GET' | 'POST' = 'GET') {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
}
