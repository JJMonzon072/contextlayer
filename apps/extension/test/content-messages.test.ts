import { describe, expect, it } from 'vitest'

import { readContentRequest, readHelloAnswer } from '../src/content/messages'
import { contentRequestSchema, helloResultSchema } from '../src/messaging/protocol'

/**
 * The content script reads messages without zod (content-script budget). These
 * cases keep its readers and the authoritative zod schemas in agreement.
 */
const requests: unknown[] = [
  { type: 'page.ping' },
  { type: 'page.deactivate' },
  { type: 'page.ping', extra: true },
  { type: 'page.delete' },
  { type: 'page.hello' },
  { type: ['page.ping'] },
  {},
  [],
  null,
  undefined,
  'page.ping',
  42,
  Object.create(null) as unknown,
]

const helloAnswers: unknown[] = [
  { ok: true, data: { active: true } },
  { ok: true, data: { active: false } },
  { ok: true, data: { active: true, extra: 1 } },
  { ok: true, data: { active: 'yes' } },
  { ok: true, data: {} },
  { ok: true },
  { ok: false, error: { code: 'FORBIDDEN', message: 'No.' } },
  { ok: false, error: { code: 'NOPE', message: 'No.' } },
  { ok: 'true', data: { active: true } },
  null,
  'ok',
]

describe('content-script message readers', () => {
  it('accept and refuse the same requests as contentRequestSchema', () => {
    for (const value of requests) {
      const parsed = contentRequestSchema.safeParse(value)
      expect(readContentRequest(value), JSON.stringify(value)).toEqual(
        parsed.success ? parsed.data : undefined,
      )
    }
  })

  it('read an active page only from a well-formed successful hello answer', () => {
    for (const value of helloAnswers) {
      const parsed = helloResultSchema.safeParse(value)
      const expected = parsed.success && parsed.data.ok ? parsed.data.data.active : undefined
      expect(readHelloAnswer(value), JSON.stringify(value)).toBe(expected)
    }
  })
})
