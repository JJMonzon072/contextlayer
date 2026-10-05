/**
 * Minimal JSON-over-HTTP client for the dashboard: the only place that calls `fetch`.
 *
 * - Every response is validated against a runtime schema (the shared zod
 *   contracts) before the UI sees it, so contract drift surfaces as a clear error.
 * - Requests go to the dashboard's own origin under `/api` (see vite.config.ts);
 *   the HttpOnly session cookie travels automatically and is never readable here.
 * - API errors arrive as the shared `ApiError` envelope and become typed
 *   `HttpError`s carrying the stable `code`.
 */
import { apiErrorSchema, type ApiErrorCode } from '@contextlayer/shared'

/** The dashboard reaches the API through its own origin (see vite.config.ts). */
export const API_BASE_PATH = '/api'

/** Structural type satisfied by any zod schema. */
export interface Parser<T> {
  parse(input: unknown): T
}

export type HttpErrorKind = 'network' | 'status' | 'invalid-response'

export class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly status: number | undefined
  /** Stable code from the API's error envelope, when the API sent one. */
  readonly code: ApiErrorCode | undefined
  /** Human-readable message from the API's error envelope. */
  readonly apiMessage: string | undefined
  /** Seconds from `retry-after` on a 429. */
  readonly retryAfterSeconds: number | undefined

  constructor(
    readonly kind: HttpErrorKind,
    message: string,
    options: {
      status?: number
      code?: ApiErrorCode
      apiMessage?: string
      retryAfterSeconds?: number
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.status = options.status
    this.code = options.code
    this.apiMessage = options.apiMessage
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

interface RequestOptions<T> {
  /** Validates the success body. Omit for responses without a body (204). */
  schema?: Parser<T>
  body?: unknown
  /** Statuses whose body follows `schema`. Defaults to any 2xx. */
  acceptedStatuses?: readonly number[]
  signal?: AbortSignal
}

export async function request<T = undefined>(
  method: Method,
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_PATH}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      signal: options.signal ?? null,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new HttpError('network', 'The request could not be sent.', { cause: error })
  }

  const accepted = options.acceptedStatuses
    ? options.acceptedStatuses.includes(response.status)
    : response.ok
  if (!accepted) throw await statusError(response)
  if (!options.schema || response.status === 204) return undefined as T

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw invalidOrUnavailable(response, 'The response is not valid JSON.', error)
  }

  try {
    return options.schema.parse(body)
  } catch (error) {
    throw invalidOrUnavailable(
      response,
      'The response does not match the expected contract.',
      error,
    )
  }
}

export function getJson<T>(
  path: string,
  schema: Parser<T>,
  options: Omit<RequestOptions<T>, 'schema' | 'body'> = {},
): Promise<T> {
  return request('GET', path, { ...options, schema })
}

async function statusError(response: Response): Promise<HttpError> {
  const retryAfter = Number(response.headers.get('retry-after'))
  let envelope: ReturnType<typeof apiErrorSchema.safeParse> | undefined
  try {
    envelope = apiErrorSchema.safeParse(await response.json())
  } catch {
    envelope = undefined
  }
  return new HttpError('status', `Unexpected HTTP status ${response.status}.`, {
    status: response.status,
    ...(envelope?.success && {
      code: envelope.data.error.code,
      apiMessage: envelope.data.error.message,
    }),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSeconds: retryAfter }),
  })
}

/**
 * A 5xx whose body is not ours (a proxy error page, Fastify's own 503 while it
 * shuts down) means the service is unavailable, not that the contract drifted.
 */
function invalidOrUnavailable(response: Response, message: string, cause: unknown): HttpError {
  return response.status >= 500
    ? new HttpError('status', `Unexpected HTTP status ${response.status}.`, {
        status: response.status,
        cause,
      })
    : new HttpError('invalid-response', message, { cause })
}
