import type { Guide, GuideStep, RichText } from '@contextlayer/shared'
import { describe, expect, it } from 'vitest'

import {
  assignSavedIds,
  fromGuide,
  move,
  newStep,
  sameJson,
  sameSteps,
  stepProblems,
  toStepInputs,
  withInstructions,
} from '../src/sidepanel/draft'

const STEP_A = '01a10a2e-864b-75bc-8800-aa3f01a05340'
const STEP_B = '01a10a2e-864b-75bc-8800-aa3f01a05341'
const STEP_C = '01a10a2e-864b-75bc-8800-aa3f01a05342'

const text = (value: string): RichText => ({
  version: 1,
  blocks: [{ type: 'paragraph', children: [{ type: 'text', text: value }] }],
})
const bold: RichText = {
  version: 1,
  blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Careful', marks: ['bold'] }] }],
}

function stored(id: string, title: string, body: RichText = text(title)): GuideStep {
  return {
    id,
    position: 0,
    title,
    body,
    target: null,
    urlPattern: { pathname: '/customers' },
    placement: 'bottom',
  }
}

function guide(steps: GuideStep[], revision = 1): Guide {
  return {
    id: '01a10a2e-864b-75bc-8800-aa3f01a05330',
    applicationId: '01a10a2e-864b-75bc-8800-aa3f01a05320',
    title: 'Create a customer',
    description: '',
    status: 'draft',
    revision,
    stepCount: steps.length,
    latestVersion: null,
    hasUnpublishedChanges: true,
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
    archivedAt: null,
    startUrlPattern: null,
    steps: steps.map((step, position) => ({ ...step, position })),
  }
}

describe('side panel draft', () => {
  it('keeps what the panel cannot edit: formatted bodies, page patterns and placement', () => {
    const [plain, formatted] = fromGuide(
      guide([stored(STEP_A, 'Open'), stored(STEP_B, 'Save', bold)]),
    )

    expect(plain?.instructions).toBe('Open')
    expect(formatted?.instructions).toBeNull()
    expect(toStepInputs([plain, formatted].filter((step) => step !== undefined))).toEqual([
      {
        id: STEP_A,
        title: 'Open',
        body: text('Open'),
        target: null,
        urlPattern: { pathname: '/customers' },
        placement: 'bottom',
      },
      {
        id: STEP_B,
        title: 'Save',
        body: bold,
        target: null,
        urlPattern: { pathname: '/customers' },
        placement: 'bottom',
      },
    ])
  })

  it('sends new steps without an id and titles trimmed', () => {
    const created = withInstructions({ ...newStep(), title: '  Save  ' }, 'Click Save.\n\n- Done')

    expect(toStepInputs([created])).toEqual([
      {
        title: 'Save',
        body: {
          version: 1,
          blocks: [
            { type: 'paragraph', children: [{ type: 'text', text: 'Click Save.' }] },
            { type: 'list', ordered: false, items: [[{ type: 'text', text: 'Done' }]] },
          ],
        },
        target: null,
        urlPattern: null,
        placement: 'auto',
      },
    ])
  })

  it('reports titles and instructions the API would refuse', () => {
    const empty = newStep()
    const long = withInstructions({ ...newStep(), title: 'Ok' }, 'x'.repeat(2001))
    const fine = { ...newStep(), title: 'Fine' }

    expect(stepProblems([empty, long, fine])).toEqual(
      new Map([
        [empty.key, 'Give this step a title.'],
        [long.key, 'Use at most 2000 characters.'],
      ]),
    )
  })

  it('moves steps within bounds only', () => {
    expect(move(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(move(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(move(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })

  it('gives saved ids to the steps that were new when the save was sent', () => {
    const [existing] = fromGuide(guide([stored(STEP_A, 'Open')]))
    if (!existing) throw new Error('no step')
    const added = { ...newStep(), title: 'Save' }
    const later = { ...newStep(), title: 'Added while saving' }
    const sent = [existing, added]
    const saved = guide([stored(STEP_A, 'Open'), stored(STEP_B, 'Save')], 2)

    const [first, second, third] = assignSavedIds([...sent, later], sent, saved)

    expect(first?.id).toBe(STEP_A)
    expect(second).toMatchObject({ key: added.key, id: STEP_B })
    expect(third).toMatchObject({ key: later.key, id: null })
  })

  it('compares JSON whatever the key order (jsonb reorders keys)', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true)
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(true)
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameJson([1, 2], [2, 1])).toBe(false)
    expect(sameJson({ a: [] }, { a: {} })).toBe(false)
  })

  it('recognizes the server copy of exactly what a save sent', () => {
    const sent = toStepInputs([
      ...fromGuide(guide([stored(STEP_A, 'Open')])),
      { ...newStep(), title: 'Save' },
    ])
    const applied = [
      stored(STEP_A, 'Open'),
      {
        ...stored(STEP_C, 'Save'),
        urlPattern: null,
        placement: 'auto' as const,
        body: { blocks: [], version: 1 as const },
      },
    ]
    const [first, second] = applied
    if (!first || !second) throw new Error('steps')

    expect(sameSteps(applied, sent)).toBe(true)
    expect(sameSteps([first], sent)).toBe(false)
    expect(sameSteps([first, { ...second, title: 'Other' }], sent)).toBe(false)
    // An existing step must keep its id.
    expect(sameSteps([{ ...first, id: STEP_B }, second], sent)).toBe(false)
  })
})
