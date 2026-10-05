import { HEALTH_PATH, healthReportSchema, type HealthReport } from '@contextlayer/shared'

import { API_BASE_URL } from '../config'

const REQUEST_TIMEOUT_MS = 5_000

/** The API answered (any status). Network failures, timeouts and redirects throw `ApiUnreachableError`. */
export class ApiUnreachableError extends Error {
  override readonly name: string = 'ApiUnreachableError'
}

/**
 * The API answered with an error status. A subclass of `ApiUnreachableError`
 * so callers that only tell "worked" from "did not" keep treating it as they
 * did; Edit Mode reads `status` and `code` to explain conflicts and refusals.
 */
export class ApiStatusError extends ApiUnreachableError {
  override readonly name = 'ApiStatusError'
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

export interface ApiClient {
  request(
    path: string,
    init?: { method?: string; body?: unknown; bearer?: string },
  ): Promise<Response>
}

/**
 * The only place where the extension talks to the ContextLayer API (ADR 0012).
 * URLs are built from the build-time origin and a known path; a resolved URL on
 * another origin is refused, so an Authorization header can never leave the API.
 * Redirects are errors, cookies are never sent, every request times out.
 */
export function createApiClient(
  baseUrl: string = API_BASE_URL,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ApiClient {
  const origin = new URL(baseUrl).origin
  return {
    async request(path, init = {}) {
      const url = new URL(path, origin)
      if (url.origin !== origin || !path.startsWith('/')) {
        throw new ApiUnreachableError('Refusing a request outside the API origin.')
      }
      try {
        return await fetchImpl(url, {
          method: init.method ?? 'GET',
          credentials: 'omit',
          redirect: 'error',
          headers: {
            accept: 'application/json',
            ...(init.body !== undefined && { 'content-type': 'application/json' }),
            ...(init.bearer !== undefined && { authorization: `Bearer ${init.bearer}` }),
          },
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        throw new ApiUnreachableError('The ContextLayer API could not be reached.', {
          cause: error,
        })
      }
    },
  }
}

/** `credentials: 'omit'`, 5 s timeout; 503 still carries a valid report. */
export async function fetchApiHealth(client: ApiClient = createApiClient()): Promise<HealthReport> {
  const response = await client.request(HEALTH_PATH)
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`Unexpected API status ${String(response.status)}`)
  }
  return healthReportSchema.parse(await response.json())
}
