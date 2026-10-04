import { HEALTH_PATH, healthReportSchema, type HealthReport } from '@contextlayer/shared'

import { getJson } from '../../lib/http'

/**
 * Reads the API readiness report. A 503 is part of the contract: it carries a
 * full report describing which dependency is down, so it is not an error here.
 */
export function fetchHealthReport(signal?: AbortSignal): Promise<HealthReport> {
  return getJson(HEALTH_PATH, healthReportSchema, {
    acceptedStatuses: [200, 503],
    ...(signal && { signal }),
  })
}
