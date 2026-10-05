import { describe, expect, it } from 'vitest'

import { describeError } from '../src/lib/errors'
import { HttpError } from '../src/lib/http'
import { apiError } from './fixtures'

describe('describeError', () => {
  it('uses the API message for client errors', () => {
    expect(describeError(apiError(409, 'CONFLICT', 'This person is already a member.'))).toBe(
      'This person is already a member.',
    )
  })

  it('never shows server internals for 5xx', () => {
    expect(describeError(apiError(500, 'INTERNAL_ERROR', 'Internal server error'))).toMatch(
      /having trouble/,
    )
  })

  it('explains network failures and rate limits', () => {
    expect(describeError(new HttpError('network', 'x'))).toMatch(/could not be reached/)
    expect(
      describeError(new HttpError('status', 'x', { status: 429, retryAfterSeconds: 30 })),
    ).toBe('Too many attempts. Try again in 1 minute.')
  })

  it('falls back to a generic message for unknown errors', () => {
    expect(describeError(new Error('boom'))).toBe('Something went wrong. Try again.')
  })
})
