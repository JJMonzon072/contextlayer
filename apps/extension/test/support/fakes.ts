import type { ExtensionTokenResponse } from '@contextlayer/shared'
import { vi } from 'vitest'

import type { ApiClient } from '../../src/background/api-client'
import type { ExtensionStorage, StorageArea } from '../../src/background/storage'

/** An in-memory chrome.storage area. */
export function memoryArea(): StorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const keys = (value: string | string[]) => (Array.isArray(value) ? value : [value])
  return {
    data,
    get: (value) =>
      Promise.resolve(
        Object.fromEntries(
          keys(value).flatMap((key) => (data.has(key) ? [[key, data.get(key)]] : [])),
        ),
      ),
    set: (items) => {
      for (const [key, item] of Object.entries(items)) data.set(key, structuredClone(item))
      return Promise.resolve()
    },
    remove: (value) => {
      for (const key of keys(value)) data.delete(key)
      return Promise.resolve()
    },
  }
}

export function memoryStorage(canRestrictLocal = true) {
  const storage = {
    local: memoryArea(),
    session: memoryArea(),
    restrictLocal: vi.fn(() => Promise.resolve(canRestrictLocal)),
  } satisfies ExtensionStorage
  return storage
}

/** Everything stored, serialized: handy to assert a secret appears nowhere. */
export function dump(storage: ReturnType<typeof memoryStorage>): string {
  return JSON.stringify([...storage.local.data, ...storage.session.data])
}

export const GRANT_A = '01a10a2e-864b-75bc-8800-aa3f01a05360'
export const GRANT_B = '01a10a2e-864b-75bc-8800-aa3f01a05361'

let serial = 0
const credential = (prefix: string) => `${prefix}${String(++serial).padStart(43, 'x')}`

/** A token response as POST /v1/extension/token returns it, with fresh credentials. */
export function tokenResponse(
  overrides: { grantId?: string; workspace?: string; accessExpiresAt?: number } = {},
): ExtensionTokenResponse {
  return {
    accessToken: credential('cla_'),
    accessTokenExpiresAt: new Date(overrides.accessExpiresAt ?? NOW + 15 * 60_000).toISOString(),
    refreshToken: credential('clr_'),
    connection: {
      id: overrides.grantId ?? GRANT_A,
      label: 'Chrome on macOS',
      createdAt: '2026-10-05T12:00:00.000Z',
      expiresAt: '2026-11-04T12:00:00.000Z',
      user: { displayName: 'Alice', email: 'alice@example.com' },
      workspace: {
        id: '01a10a2e-864b-75bc-8800-aa3f01a05314',
        name: overrides.workspace ?? 'Acme',
      },
    },
  }
}

export const NOW = Date.parse('2026-10-05T12:00:00.000Z')

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export interface Call {
  path: string
  method: string
  body: unknown
  bearer: string | undefined
}

/**
 * An ApiClient driven by a handler, recording every call. The handler may
 * return a promise the test resolves later (a slow or lost response).
 */
export function fakeApi(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const api: ApiClient = {
    request: (path, init = {}) => {
      const call = {
        path,
        method: init.method ?? 'GET',
        body: init.body,
        bearer: init.bearer,
      }
      calls.push(call)
      return Promise.resolve(handler(call))
    },
  }
  return { api, calls }
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
