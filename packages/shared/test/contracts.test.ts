import { describe, expect, it } from 'vitest'

import { apiErrorSchema, healthReportSchema, type HealthReport } from '../src/index.js'

const healthyReport: HealthReport = {
  status: 'ok',
  service: 'contextlayer-api',
  version: '0.0.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 12.5,
  checks: { database: { status: 'up', latencyMs: 3 } },
}

describe('healthReportSchema', () => {
  it('accepts a healthy report', () => {
    expect(healthReportSchema.parse(healthyReport)).toEqual(healthyReport)
  })

  it('accepts an unavailable report with a failing dependency', () => {
    const report = {
      ...healthyReport,
      status: 'unavailable',
      checks: { database: { status: 'down', latencyMs: 2000 } },
    }

    expect(healthReportSchema.safeParse(report).success).toBe(true)
  })

  it('rejects reports from a different service', () => {
    const result = healthReportSchema.safeParse({ ...healthyReport, service: 'other' })

    expect(result.success).toBe(false)
  })

  it('rejects non ISO-8601 timestamps', () => {
    const result = healthReportSchema.safeParse({ ...healthyReport, timestamp: 'yesterday' })

    expect(result.success).toBe(false)
  })
})

describe('apiErrorSchema', () => {
  it('accepts a known error code', () => {
    const body = { error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'req-1' } }

    expect(apiErrorSchema.parse(body)).toEqual(body)
  })

  it('rejects unknown error codes', () => {
    const result = apiErrorSchema.safeParse({ error: { code: 'TEAPOT', message: 'nope' } })

    expect(result.success).toBe(false)
  })
})
