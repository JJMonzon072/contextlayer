import { describe, expect, it } from 'vitest'

import {
  canAddStep,
  moveStep,
  newStep,
  stepsFingerprint,
  stepsRequest,
  toDraftSteps,
  validateStep,
} from '../src/features/guides/guide-editor'
import { guide } from './fixtures'

describe('guide editor state', () => {
  it('sends the list in its current order, keeping ids of saved steps', () => {
    const steps = toDraftSteps(guide().steps)
    const added = { ...newStep(), title: 'Fill in the details', text: 'Enter the name.' }

    const reordered = moveStep([...steps, added], 2, -1)
    const request = stepsRequest(reordered, 2)

    expect(request.expectedRevision).toBe(2)
    expect(request.steps.map((step) => step.title)).toEqual([
      'Open Customers',
      'Fill in the details',
      'Click New customer',
    ])
    expect(request.steps.map((step) => step.id)).toEqual([
      guide().steps[0]?.id,
      undefined,
      guide().steps[1]?.id,
    ])
    expect(request.steps[1]?.body).toEqual({
      version: 1,
      blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Enter the name.' }] }],
    })
  })

  it('does not move past either end', () => {
    const steps = toDraftSteps(guide().steps)

    expect(moveStep(steps, 0, -1).map((step) => step.id)).toEqual(steps.map((step) => step.id))
    expect(moveStep(steps, 1, 1).map((step) => step.id)).toEqual(steps.map((step) => step.id))
  })

  it('detects changes by content, not by object identity', () => {
    const steps = toDraftSteps(guide().steps)
    const baseline = stepsFingerprint(steps)

    expect(stepsFingerprint(toDraftSteps(guide().steps))).toBe(baseline)
    expect(stepsFingerprint(moveStep(steps, 0, 1))).not.toBe(baseline)
    expect(stepsFingerprint(steps.map((step) => ({ ...step, title: `${step.title}!` })))).not.toBe(
      baseline,
    )
  })

  it('validates titles and instruction length like the API', () => {
    expect(validateStep({ ...newStep(), title: ' ' }).title).toBeDefined()
    expect(validateStep({ ...newStep(), title: 'OK', text: 'x'.repeat(2001) }).text).toBeDefined()
    expect(validateStep({ ...newStep(), title: 'OK', text: 'Fine.' })).toEqual({})
  })

  it('caps a guide at 50 steps', () => {
    expect(canAddStep(Array.from({ length: 49 }, newStep))).toBe(true)
    expect(canAddStep(Array.from({ length: 50 }, newStep))).toBe(false)
  })
})
