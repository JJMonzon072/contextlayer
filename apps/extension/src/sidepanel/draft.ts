import {
  plainTextLength,
  plainTextToRichText,
  RICH_TEXT_MAX_CHARACTERS,
  richTextToPlainText,
  type Guide,
  type GuideStep,
  type RichText,
  type RichTextInline,
  type StepInput,
} from '@contextlayer/shared'

import { PREVIEW_MAX_LINES, type DraftStep, type LocalDraft } from '../messaging/protocol'

/**
 * The side panel's working copy of a guide's steps. Pure functions over plain
 * data, so the editing rules (ids kept across reorders, nothing dropped that
 * the panel cannot edit, what counts as "the same steps") are tested without
 * a browser.
 */

export interface EditorStep extends DraftStep {
  /** Stable within the panel, for Vue and for matching saved ids to new steps. */
  key: string
  /**
   * The instructions as plain text, or `null` when the stored body uses
   * formatting the plain-text editor cannot represent: then the body is kept
   * untouched and edited in the dashboard only.
   */
  instructions: string | null
  /** The capture request whose element this page still holds (for the preview). */
  captureId: string | null
}

let counter = 0
const nextKey = () => `step-${String(++counter)}`

function editorStep(step: DraftStep, captureId: string | null = null): EditorStep {
  return {
    ...step,
    key: nextKey(),
    instructions: richTextToPlainText(step.body) ?? null,
    captureId,
  }
}

export function fromGuide(guide: Guide): EditorStep[] {
  return guide.steps.map((step) =>
    editorStep({
      id: step.id,
      title: step.title,
      body: step.body,
      target: step.target,
      urlPattern: step.urlPattern,
      placement: step.placement,
    }),
  )
}

export function fromLocal(local: LocalDraft): EditorStep[] {
  return local.steps.map((step) => editorStep(step))
}

export function newStep(): EditorStep {
  return editorStep({
    id: null,
    title: '',
    body: { version: 1, blocks: [] },
    target: null,
    urlPattern: null,
    placement: 'auto',
  })
}

/** What the worker keeps in `storage.session`: no panel-only fields. */
export function toDraft(steps: readonly EditorStep[]): DraftStep[] {
  return steps.map(({ id, title, body, target, urlPattern, placement }) => ({
    id,
    title,
    body,
    target,
    urlPattern,
    placement,
  }))
}

/** The API's step list: titles trimmed, new steps without an id, the rest as loaded. */
export function toStepInputs(steps: readonly EditorStep[]): StepInput[] {
  return steps.map((step) => ({
    ...(step.id !== null && { id: step.id }),
    title: step.title.trim(),
    body: step.body,
    target: step.target,
    urlPattern: step.urlPattern,
    placement: step.placement,
  }))
}

export function withInstructions(step: EditorStep, text: string): EditorStep {
  return { ...step, instructions: text, body: plainTextToRichText(text) }
}

export function move<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta
  if (index < 0 || target < 0 || target >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(index, 1)
  if (item !== undefined) next.splice(target, 0, item)
  return next
}

/** Problems that would make the API refuse the save, by step key. */
export function stepProblems(steps: readonly EditorStep[]): Map<string, string> {
  const problems = new Map<string, string>()
  for (const step of steps) {
    if (step.title.trim() === '') problems.set(step.key, 'Give this step a title.')
    else if (step.title.trim().length > 120) problems.set(step.key, 'Use at most 120 characters.')
    else if (
      step.instructions !== null &&
      plainTextLength(step.instructions) > RICH_TEXT_MAX_CHARACTERS
    ) {
      problems.set(step.key, `Use at most ${String(RICH_TEXT_MAX_CHARACTERS)} characters.`)
    }
  }
  return problems
}

/**
 * After a save, steps that were new when it was sent get the ids the server
 * gave them (the server keeps the order it was sent). Steps added or edited
 * after the save started keep their state.
 */
export function assignSavedIds(
  current: readonly EditorStep[],
  sent: readonly EditorStep[],
  saved: Guide,
): EditorStep[] {
  const ids = new Map<string, string>()
  sent.forEach((step, index) => {
    const id = saved.steps[index]?.id
    if (step.id === null && id !== undefined) ids.set(step.key, id)
  })
  return current.map((step) =>
    step.id === null && ids.has(step.key) ? { ...step, id: ids.get(step.key) ?? null } : step,
  )
}

/** Deep equality that ignores object key order (PostgreSQL `jsonb` reorders keys). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]))
  }
  const left = Object.entries(a).filter(([, value]) => value !== undefined)
  const right = Object.entries(b).filter(([, value]) => value !== undefined)
  if (left.length !== right.length) return false
  const other = Object.fromEntries(right) as Record<string, unknown>
  return left.every(([key, value]) => key in other && sameJson(value, other[key]))
}

/**
 * Whether the server's steps are exactly what a save sent: used when a save's
 * answer was lost, to tell "applied" from "not applied" by content, never by
 * guessing. New steps have no id yet, so only their content is compared.
 */
export function sameSteps(server: readonly GuideStep[], sent: readonly StepInput[]): boolean {
  return (
    server.length === sent.length &&
    sent.every((step, index) => {
      const stored = server[index]
      if (!stored || (step.id !== undefined && step.id !== stored.id)) return false
      return (
        stored.title === step.title &&
        sameJson(stored.body, step.body) &&
        sameJson(stored.target, step.target ?? null) &&
        sameJson(stored.urlPattern, step.urlPattern ?? null) &&
        stored.placement === (step.placement ?? 'auto')
      )
    })
  )
}

const inlineText = (nodes: readonly RichTextInline[]): string =>
  nodes.map((node) => (node.type === 'text' ? node.text : inlineText(node.children))).join('')

/** The instructions as lines of plain text for the on-page preview (links shown as their text). */
export function richTextLines(document: RichText): string[] {
  return document.blocks
    .flatMap((block) =>
      block.type === 'paragraph'
        ? [inlineText(block.children)]
        : block.items.map(
            (item, index) => `${block.ordered ? `${String(index + 1)}.` : '•'} ${inlineText(item)}`,
          ),
    )
    .slice(0, PREVIEW_MAX_LINES)
}
