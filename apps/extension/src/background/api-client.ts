import { HEALTH_PATH, healthReportSchema, type HealthReport } from '@contextlayer/shared'

import { API_BASE_URL } from '../config'

const REQUEST_TIMEOUT_MS = 5_000

/**
 * The only place where the extension talks to the ContextLayer API.
 * `host_permissions` for the API origin lets the service worker fetch it
 * without CORS; credentials are omitted until authentication exists.
 */
export async function fetchApiHealth(baseUrl: string = API_BASE_URL): Promise<HealthReport> {
  const response = await fetch(new URL(HEALTH_PATH, baseUrl), {
    headers: { accept: 'application/json' },
    credentials: 'omit',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  // 503 still carries a valid report describing the failing dependency.
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`Unexpected API status ${response.status}`)
  }

  return healthReportSchema.parse(await response.json())
}
