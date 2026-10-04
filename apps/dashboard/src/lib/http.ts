/**
 * Minimal JSON-over-HTTP client for the dashboard.
 *
 * Every response is validated against a runtime schema (the shared zod
 * contracts) before the UI sees it: a contract drift between API and dashboard
 * surfaces as a clear error instead of `undefined` deep inside a component.
 */

/** The dashboard reaches the API through its own origin (see vite.config.ts). */
export const API_BASE_PATH = '/api'

/** Structural type satisfied by any zod schema, so this module does not depend on zod. */
export interface Parser<T> {
  parse(input: unknown): T
}

export type HttpErrorKind = 'network' | 'status' | 'invalid-response'

export class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly status: number | undefined

  constructor(
    readonly kind: HttpErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.status = options.status
  }
}

interface GetJsonOptions {
  /** Statuses whose body follows the schema. Defaults to `[200]`. */
  acceptedStatuses?: readonly number[]
  signal?: AbortSignal
}

export async function getJson<T>(
  path: string,
  schema: Parser<T>,
  options: GetJsonOptions = {},
): Promise<T> {
  const acceptedStatuses = options.acceptedStatuses ?? [200]

  let response: Response
  try {
    response = await fetch(`${API_BASE_PATH}${path}`, {
      headers: { accept: 'application/json' },
      signal: options.signal ?? null,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new HttpError('network', 'The request could not be sent.', { cause: error })
  }

  if (!acceptedStatuses.includes(response.status)) {
    throw new HttpError('status', `Unexpected HTTP status ${response.status}.`, {
      status: response.status,
    })
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new HttpError('invalid-response', 'The response is not valid JSON.', { cause: error })
  }

  try {
    return schema.parse(body)
  } catch (error) {
    throw new HttpError('invalid-response', 'The response does not match the expected contract.', {
      cause: error,
    })
  }
}
