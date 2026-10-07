/**
 * The content script's side of the message protocol, without zod: this file
 * ships in every enabled page, so it uses small hand-written readers instead
 * of the schema library (content-script budget, `scripts/budget.ts`). The
 * readers mirror the zod schemas in `src/messaging/protocol.ts`, which stay
 * authoritative for the worker and the extension pages;
 * `test/content-messages.test.ts` checks that both accept and refuse the same
 * inputs.
 */
import type { PlayerStep } from '../messaging/protocol'
import { failure, MESSAGE_ERROR_CODES, type MessageResult } from '../messaging/result'

export type ContentRequest =
  | { type: 'page.ping' }
  | { type: 'page.deactivate' }
  | { type: 'picker.start'; captureId: string; ttlMs: number }
  | { type: 'picker.stop'; captureId: string }
  | { type: 'preview.show'; captureId: string; title: string; lines: string[] }
  | { type: 'preview.hide' }
  | { type: 'player.show'; step: PlayerStep }
  | { type: 'player.hide'; runId: string }
  | { type: 'player.focus' }

/** Mirrors `PICKER_TTL_MS`, `captureIdSchema` and `previewTextSchema` in the protocol. */
const PICKER_TTL_MS = 120_000
const CAPTURE_ID = /^[A-Za-z0-9_-]{16,64}$/
const PREVIEW_MAX_LINES = 40

const isPreviewText = (title: unknown, lines: unknown): lines is string[] =>
  typeof title === 'string' &&
  title.length <= 120 &&
  Array.isArray(lines) &&
  lines.length <= PREVIEW_MAX_LINES &&
  lines.every((line) => typeof line === 'string' && line.length <= 2_000)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Exactly these keys, like a zod strict object. */
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

/** Mirrors `runIdSchema`, `MAX_GUIDE_STEPS`, `STEP_PLACEMENTS` and `TARGET_FALLBACKS`. */
const RUN_ID = /^[A-Za-z0-9_-]{16,64}$/
const MAX_GUIDE_STEPS = 50
const PLACEMENTS = ['auto', 'top', 'right', 'bottom', 'left']
const FALLBACKS = ['show-unanchored', 'skip', 'end']
const URL_PATTERN_KEYS = ['protocol', 'hostname', 'port', 'pathname', 'search', 'hash']

const isInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const isRatio = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 1

/** Mirrors `urlPatternSchema`: known parts, 1–256 characters, no spaces or control characters. */
function isUrlPattern(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, URL_PATTERN_KEYS)) return false
  const parts = Object.values(value)
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        typeof part === 'string' &&
        part.length >= 1 &&
        part.length <= 256 &&
        // eslint-disable-next-line no-control-regex -- control characters are what is refused.
        !/[\s\u0000-\u001f\u007f-\u009f]/.test(part),
    )
  )
}

/**
 * The outline of a TargetDescriptor v1. The worker validated the whole
 * descriptor with the shared schema before sending it (it is the only sender
 * of `player.show`); the resolver reads it defensively and fails closed on
 * anything malformed below this outline.
 */
function isTargetOutline(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1) return false
  const { page, framePath, shadowPath, element, anchors, locators, resolution } = value
  return (
    isRecord(page) &&
    isUrlPattern(page.urlPattern) &&
    Array.isArray(framePath) &&
    Array.isArray(shadowPath) &&
    isRecord(element) &&
    Array.isArray(anchors) &&
    Array.isArray(locators) &&
    locators.length >= 1 &&
    locators.length <= 12 &&
    isRecord(resolution) &&
    isRatio(resolution.minScore) &&
    isRatio(resolution.minMargin) &&
    FALLBACKS.includes(resolution.onAmbiguous as string) &&
    FALLBACKS.includes(resolution.onNotFound as string)
  )
}

const STEP_KEYS = [
  'runId',
  'generation',
  'guideTitle',
  'index',
  'count',
  'title',
  'lines',
  'target',
  'urlPattern',
  'placement',
]

/** One step of a running guide (mirrors `playerStepSchema`), or undefined. */
export function readPlayerStep(value: unknown): PlayerStep | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, STEP_KEYS)) return undefined
  const { runId, generation, guideTitle, index, count, title, lines, target, urlPattern } = value
  const placement = value.placement as PlayerStep['placement']
  if (
    typeof runId !== 'string' ||
    !RUN_ID.test(runId) ||
    !isInteger(generation, 0) ||
    typeof guideTitle !== 'string' ||
    guideTitle.length > 120 ||
    !isInteger(count, 1, MAX_GUIDE_STEPS) ||
    !isInteger(index, 0, (count as number) - 1) ||
    typeof title !== 'string' ||
    title.length < 1 ||
    !isPreviewText(title, lines) ||
    (target !== null && !isTargetOutline(target)) ||
    (urlPattern !== null && !isUrlPattern(urlPattern)) ||
    !PLACEMENTS.includes(placement)
  ) {
    return undefined
  }
  return {
    runId,
    generation: generation as number,
    guideTitle,
    index: index as number,
    count: count as number,
    title,
    lines: [...lines],
    target: target as PlayerStep['target'],
    urlPattern: urlPattern as PlayerStep['urlPattern'],
    placement,
  }
}

/** The worker's answer to `player.go`: the step to show, or the error code. */
export function readStepAnswer(value: unknown): { step: PlayerStep } | { error: string } {
  if (isRecord(value) && value.ok === true) {
    const step = readPlayerStep(value.data)
    if (step) return { step }
  }
  if (isRecord(value) && value.ok === false && isRecord(value.error)) {
    const { code, message } = value.error
    if (MESSAGE_ERROR_CODES.includes(code as never) && typeof message === 'string') {
      return { error: code as string }
    }
  }
  return { error: 'INTERNAL_ERROR' }
}

/**
 * The worker's answer to `player.resume` (mirrors `playerResumeResultSchema`):
 * the step to show, `null` for nothing to resume, `undefined` for a failure
 * or anything malformed.
 */
export function readResumeAnswer(value: unknown): PlayerStep | null | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined
  if (value.data === null) return null
  return readPlayerStep(value.data)
}

/** A request from the extension to this content script, or undefined. */
export function readContentRequest(value: unknown): ContentRequest | undefined {
  if (!isRecord(value)) return undefined
  const { type, captureId, ttlMs, title, lines } = value
  if (
    type === 'page.ping' ||
    type === 'page.deactivate' ||
    type === 'preview.hide' ||
    type === 'player.focus'
  ) {
    return hasOnlyKeys(value, ['type']) ? { type } : undefined
  }
  if (type === 'player.show') {
    const step = hasOnlyKeys(value, ['type', 'step']) ? readPlayerStep(value.step) : undefined
    return step && { type, step }
  }
  if (type === 'player.hide') {
    const { runId } = value
    return hasOnlyKeys(value, ['type', 'runId']) && typeof runId === 'string' && RUN_ID.test(runId)
      ? { type, runId }
      : undefined
  }
  if (typeof captureId !== 'string' || !CAPTURE_ID.test(captureId)) return undefined
  if (type === 'picker.stop' && hasOnlyKeys(value, ['type', 'captureId'])) {
    return { type, captureId }
  }
  if (
    type === 'preview.show' &&
    hasOnlyKeys(value, ['type', 'captureId', 'title', 'lines']) &&
    isPreviewText(title, lines)
  ) {
    return { type, captureId, title: title as string, lines: [...lines] }
  }
  if (
    type === 'picker.start' &&
    hasOnlyKeys(value, ['type', 'captureId', 'ttlMs']) &&
    typeof ttlMs === 'number' &&
    Number.isInteger(ttlMs) &&
    ttlMs >= 1_000 &&
    ttlMs <= PICKER_TTL_MS
  ) {
    return { type, captureId, ttlMs }
  }
  return undefined
}

/**
 * The worker's answer to `page.hello`: `true` or `false` for a well-formed
 * success, `undefined` for a failure or anything malformed.
 */
export function readHelloAnswer(value: unknown): boolean | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return undefined
  return typeof value.data.active === 'boolean' ? value.data.active : undefined
}

/** Sends a message to the service worker; an unreachable worker is an answer, not an error. */
export async function askWorker(message: object): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    // e.g. "Extension context invalidated" after the extension was reloaded.
    return failure('INTERNAL_ERROR', 'The extension service worker is not reachable.')
  }
}

export type { MessageResult }
