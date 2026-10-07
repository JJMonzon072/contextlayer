import { describe, expect, it } from 'vitest'

import { captureTarget } from '../src/content/capture/descriptor'
import {
  readContentRequest,
  readHelloAnswer,
  readResumeAnswer,
  readStepAnswer,
} from '../src/content/messages'
import {
  contentRequestSchema,
  helloResultSchema,
  playerResumeResultSchema,
  playerStepResultSchema,
} from '../src/messaging/protocol'

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

  it('accept and refuse the same player messages as contentRequestSchema', () => {
    for (const value of playerRequests()) {
      const parsed = contentRequestSchema.safeParse(value)
      expect(readContentRequest(value), JSON.stringify(value)).toEqual(
        parsed.success ? parsed.data : undefined,
      )
    }
  })

  it('read a step answer like playerStepResultSchema', () => {
    const answers: unknown[] = [
      ...playerSteps().map((data) => ({ ok: true, data })),
      { ok: false, error: { code: 'STALE', message: 'No longer playing.' } },
      { ok: false, error: { code: 'BAD_REQUEST', message: 'No step there.' } },
      { ok: false, error: { code: 'NOPE', message: 'x' } },
      { ok: false, error: { code: 'STALE' } },
      { ok: false },
      { ok: true },
      null,
      'STALE',
    ]
    for (const value of answers) {
      const parsed = playerStepResultSchema.safeParse(value)
      const expected = !parsed.success
        ? { error: 'INTERNAL_ERROR' }
        : parsed.data.ok
          ? { step: parsed.data.data }
          : { error: parsed.data.error.code }
      expect(readStepAnswer(value), JSON.stringify(value)).toEqual(expected)
    }
  })

  it('read a resume answer like playerResumeResultSchema', () => {
    const answers: unknown[] = [
      ...playerSteps().map((data) => ({ ok: true, data })),
      { ok: true, data: null },
      { ok: true },
      { ok: false, error: { code: 'STALE', message: 'The connection ended.' } },
      { ok: 'true', data: null },
      null,
    ]
    for (const value of answers) {
      const parsed = playerResumeResultSchema.safeParse(value)
      const expected = parsed.success && parsed.data.ok ? parsed.data.data : undefined
      expect(readResumeAnswer(value), JSON.stringify(value)).toEqual(expected)
    }
  })

  it('check only the outline of a target, which the worker validated in full', () => {
    // The worker is the only sender of player.show and parses the snapshot
    // with the shared schema; below the outline the resolver fails closed.
    const [valid] = playerSteps()
    const target = { ...captured(), locators: [{ strategy: 'nope' }] }
    const message = { type: 'player.show', step: { ...(valid as object), target } }

    expect(contentRequestSchema.safeParse(message).success).toBe(false)
    expect(readContentRequest(message)).toBeDefined()
  })
})

const RUN = 'Rn1_run-id-0123456789abcdef'

function captured() {
  document.body.innerHTML = '<button type="button" data-testid="new-customer">New customer</button>'
  const button = document.querySelector('button')
  if (!button) throw new Error('no button')
  const outcome = captureTarget(button, {
    extensionVersion: '0.1.0',
    capturedAt: new Date('2026-10-06T10:00:00Z'),
    href: 'http://127.0.0.1:4400/customers',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.descriptor
}

/** Steps around every rule of playerStepSchema, valid and not. */
function playerSteps(): unknown[] {
  const step = {
    runId: RUN,
    generation: 2,
    guideTitle: 'Create a customer',
    index: 1,
    count: 3,
    title: 'Type the name',
    lines: ['Type the customer name.'],
    target: null,
    urlPattern: null,
    placement: 'auto',
  }
  const target = captured()
  return [
    step,
    { ...step, target },
    { ...step, urlPattern: { pathname: '/customers/:id' } },
    { ...step, urlPattern: { pathname: '/customers', hash: 'x' } },
    { ...step, generation: 0, index: 0, count: 1 },
    { ...step, count: 50, index: 49 },
    { ...step, runId: 'short' },
    { ...step, runId: `${RUN}!` },
    { ...step, generation: -1 },
    { ...step, generation: 1.5 },
    { ...step, index: 3 },
    { ...step, index: -1 },
    { ...step, count: 0, index: 0 },
    { ...step, count: 51 },
    { ...step, title: '' },
    { ...step, title: 'x'.repeat(121) },
    { ...step, guideTitle: 'x'.repeat(121) },
    { ...step, lines: Array(41).fill('a') },
    { ...step, lines: ['x'.repeat(2_001)] },
    { ...step, lines: [1] },
    { ...step, placement: 'center' },
    { ...step, urlPattern: {} },
    { ...step, urlPattern: { pathname: '' } },
    { ...step, urlPattern: { pathname: '/a b' } },
    { ...step, urlPattern: { pathname: '/a\u0007' } },
    { ...step, urlPattern: { pathname: 'x'.repeat(257) } },
    { ...step, urlPattern: { pathname: '/x', query: 'y' } },
    { ...step, urlPattern: { pathname: 7 } },
    { ...step, target: 'button' },
    { ...step, target: { ...target, version: 2 } },
    { ...step, target: { ...target, locators: [] } },
    { ...step, target: { ...target, page: { urlPattern: {} } } },
    { ...step, target: { ...target, resolution: { ...target.resolution, minScore: 2 } } },
    { ...step, target: { ...target, resolution: { ...target.resolution, onNotFound: 'retry' } } },
    { ...step, html: '<b>x</b>' },
    Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'target')),
    Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'urlPattern')),
    null,
    [],
  ]
}

function playerRequests(): unknown[] {
  return [
    ...playerSteps().map((step) => ({ type: 'player.show', step })),
    { type: 'player.show' },
    { type: 'player.show', step: playerSteps()[0], runId: RUN },
    { type: 'player.hide', runId: RUN },
    { type: 'player.hide', runId: 'short' },
    { type: 'player.hide' },
    { type: 'player.hide', runId: RUN, step: 1 },
    { type: 'player.go', runId: RUN, generation: 1, direction: 'next' },
    { type: 'player.focus' },
    { type: 'player.focus', runId: RUN },
  ]
}
