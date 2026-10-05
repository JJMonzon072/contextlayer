import { describe, expect, it } from 'vitest'

import { readContentRequest, readHelloAnswer } from '../src/content/messages'
import { contentRequestSchema, helloResultSchema } from '../src/messaging/protocol'

/**
 * The content script reads messages without zod (content-script budget). These
 * cases keep its readers and the authoritative zod schemas in agreement.
 */
const CAPTURE = 'Zk3_q-9xYt2LmN8pQ4rS'

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
  { type: 'picker.start', captureId: CAPTURE, ttlMs: 120_000 },
  { type: 'picker.start', captureId: CAPTURE, ttlMs: 1_000 },
  { type: 'picker.start', captureId: CAPTURE, ttlMs: 999 },
  { type: 'picker.start', captureId: CAPTURE, ttlMs: 120_001 },
  { type: 'picker.start', captureId: CAPTURE, ttlMs: 1_500.5 },
  { type: 'picker.start', captureId: CAPTURE, ttlMs: '2000' },
  { type: 'picker.start', captureId: CAPTURE },
  { type: 'picker.start', captureId: CAPTURE, ttlMs: 2_000, extra: 1 },
  { type: 'picker.start', captureId: 'short', ttlMs: 2_000 },
  { type: 'picker.start', captureId: `${CAPTURE}!`, ttlMs: 2_000 },
  { type: 'picker.start', captureId: 'x'.repeat(65), ttlMs: 2_000 },
  { type: 'picker.stop', captureId: CAPTURE },
  { type: 'picker.stop', captureId: CAPTURE, ttlMs: 2_000 },
  { type: 'picker.stop' },
  { type: 'picker.result', captureId: CAPTURE },
  { type: 'page.ping', captureId: CAPTURE },
  { type: 'preview.show', captureId: CAPTURE, title: 'Save', lines: ['Click Save.'] },
  { type: 'preview.show', captureId: CAPTURE, title: '', lines: [] },
  { type: 'preview.show', captureId: CAPTURE, title: 'x'.repeat(121), lines: [] },
  { type: 'preview.show', captureId: CAPTURE, title: 'Save', lines: ['x'.repeat(2_001)] },
  { type: 'preview.show', captureId: CAPTURE, title: 'Save', lines: Array(41).fill('a') },
  { type: 'preview.show', captureId: CAPTURE, title: 'Save', lines: [1] },
  { type: 'preview.show', captureId: CAPTURE, title: 'Save', lines: 'Click' },
  { type: 'preview.show', captureId: CAPTURE, title: 7, lines: [] },
  { type: 'preview.show', captureId: CAPTURE, title: 'Save' },
  { type: 'preview.show', captureId: CAPTURE, title: 'Save', lines: [], html: '<b>x</b>' },
  { type: 'preview.show', title: 'Save', lines: [] },
  { type: 'preview.hide' },
  { type: 'preview.hide', captureId: CAPTURE },
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
