import {
  MAX_GUIDE_STEPS,
  richTextSchema,
  stepTitleSchema,
  type GuideStep,
  type ReplaceStepsRequest,
  type RichText,
  type StepPlacement,
  type TargetDescriptor,
  type UrlPattern,
} from '@contextlayer/shared'

import { plainTextToRichText, richTextToPlainText } from './rich-text'

/** One step as the editor holds it, saved or not. */
export interface DraftStep {
  /** Stable key for rendering, also before the step has an id. */
  key: string
  id: string | undefined
  title: string
  /** Plain-text instructions; `undefined` when the stored body uses formatting this editor cannot change. */
  text: string | undefined
  /** The stored body, sent back unchanged while `text` is `undefined`. */
  body: RichText
  target: TargetDescriptor | null
  urlPattern: UrlPattern | null
  placement: StepPlacement
}

let lastKey = 0
function nextKey(): string {
  lastKey += 1
  return `step-${String(lastKey)}`
}

export function toDraftSteps(steps: readonly GuideStep[]): DraftStep[] {
  return steps.map((step) => ({
    key: nextKey(),
    id: step.id,
    title: step.title,
    text: richTextToPlainText(step.body),
    body: step.body,
    target: step.target,
    urlPattern: step.urlPattern,
    placement: step.placement,
  }))
}

export function newStep(): DraftStep {
  return {
    key: nextKey(),
    id: undefined,
    title: '',
    text: '',
    body: { version: 1, blocks: [] },
    target: null,
    urlPattern: null,
    placement: 'auto',
  }
}

export const canAddStep = (steps: readonly DraftStep[]) => steps.length < MAX_GUIDE_STEPS

/** A new array with the step at `index` moved one place up (-1) or down (+1). */
export function moveStep(steps: readonly DraftStep[], index: number, offset: -1 | 1): DraftStep[] {
  const destination = index + offset
  const copy = [...steps]
  if (destination < 0 || destination >= steps.length) return copy
  const [moved] = copy.splice(index, 1)
  if (moved) copy.splice(destination, 0, moved)
  return copy
}

export function stepBody(step: DraftStep): RichText {
  return step.text === undefined ? step.body : plainTextToRichText(step.text)
}

/** The full ordered list for PUT …/steps: the array order is the position. */
export function stepsRequest(
  steps: readonly DraftStep[],
  expectedRevision: number,
): ReplaceStepsRequest {
  return {
    expectedRevision,
    steps: steps.map((step) => ({
      ...(step.id !== undefined ? { id: step.id } : {}),
      title: step.title.trim(),
      body: stepBody(step),
      target: step.target,
      urlPattern: step.urlPattern,
      placement: step.placement,
    })),
  }
}

/** Comparable form of the list, to tell whether there is anything to save. */
export function stepsFingerprint(steps: readonly DraftStep[]): string {
  return JSON.stringify(stepsRequest(steps, 1).steps)
}

export interface StepErrors {
  title?: string
  text?: string
}

/** The API's rules, checked before saving so errors point at the right step. */
export function validateStep(step: DraftStep): StepErrors {
  const errors: StepErrors = {}
  if (!stepTitleSchema.safeParse(step.title).success) {
    errors.title = 'Give the step a title of 1 to 120 characters.'
  }
  const body = richTextSchema.safeParse(stepBody(step))
  if (!body.success) {
    errors.text = 'Keep the instructions under 2000 characters and 20 paragraphs.'
  }
  return errors
}
