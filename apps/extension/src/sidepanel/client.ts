import type { Guide, GuideSummary, ReplaceStepsRequest } from '@contextlayer/shared'

import { sendToBackground } from '../messaging/background-client'
import {
  authoringAttachResultSchema,
  authoringCaptureResultSchema,
  authoringCaptureStartResultSchema,
  authoringDoneResultSchema,
  authoringGuideResultSchema,
  authoringGuidesResultSchema,
  authoringLocalResultSchema,
  authoringSaveResultSchema,
  authoringStateResultSchema,
  previewResultSchema,
  type AuthoringAttachData,
  type AuthoringCaptureData,
  type AuthoringStateData,
  type FinalCopy,
  type LocalDraft,
  type LocalDraftInput,
  type MessageResult,
} from '../messaging/protocol'

/**
 * The side panel's requests to the worker. The panel never calls the API or
 * a content script itself; every answer is validated before use.
 */
export interface AuthoringClient {
  attach(tabId: number): Promise<MessageResult<AuthoringAttachData>>
  state(panelId: string): Promise<MessageResult<AuthoringStateData>>
  guides(panelId: string, applicationId: string): Promise<MessageResult<{ items: GuideSummary[] }>>
  open(
    panelId: string,
    applicationId: string,
    guideId: string,
  ): Promise<MessageResult<{ guide: Guide; local: LocalDraft | null }>>
  create(
    panelId: string,
    applicationId: string,
    title: string,
  ): Promise<MessageResult<{ guide: Guide; local: LocalDraft | null }>>
  resume(panelId: string): Promise<MessageResult<{ done: boolean }>>
  startCapture(panelId: string): Promise<MessageResult<{ captureId: string }>>
  cancelCapture(panelId: string): Promise<MessageResult<{ done: boolean }>>
  takeCapture(panelId: string, captureId: string): Promise<MessageResult<AuthoringCaptureData>>
  save(
    panelId: string,
    operationId: string,
    applicationId: string,
    guideId: string,
    request: ReplaceStepsRequest,
  ): Promise<MessageResult<{ operationId: string; guide: Guide }>>
  /** `version`: the panel's edit counter for this copy. */
  writeLocal(
    panelId: string,
    draft: LocalDraftInput,
    version: number,
  ): Promise<MessageResult<{ stored: boolean; reason: 'too-large' | 'quota' | 'outdated' | null }>>
  /** Drops the guide's copy unless this panel wrote a newer one than `version` since. */
  clearLocal(
    panelId: string,
    guideId: string,
    version: number,
  ): Promise<MessageResult<{ done: boolean }>>
  showPreview(
    panelId: string,
    captureId: string,
    title: string,
    lines: string[],
  ): Promise<MessageResult<{ shown: boolean }>>
  hidePreview(panelId: string): Promise<MessageResult<{ done: boolean }>>
  exit(panelId: string, final?: FinalCopy): Promise<MessageResult<{ done: boolean }>>
  /**
   * From `pagehide`, with the last copy the worker has not confirmed: one
   * message, sent at once (the page may be gone before any answer, and
   * cannot send anything after it).
   */
  detach(panelId: string, final?: FinalCopy): void
}

/**
 * A plain JSON copy of what the panel edits: its state is made of Vue proxies,
 * which extension messaging should not be trusted to serialize.
 */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const chromeAuthoringClient: AuthoringClient = {
  attach: (tabId) =>
    sendToBackground({ type: 'authoring.attach', tabId }, authoringAttachResultSchema),
  state: (panelId) =>
    sendToBackground({ type: 'authoring.state', panelId }, authoringStateResultSchema),
  guides: (panelId, applicationId) =>
    sendToBackground(
      { type: 'authoring.guides', panelId, applicationId },
      authoringGuidesResultSchema,
    ),
  open: (panelId, applicationId, guideId) =>
    sendToBackground(
      { type: 'authoring.open', panelId, applicationId, guideId },
      authoringGuideResultSchema,
    ),
  create: (panelId, applicationId, title) =>
    sendToBackground(
      { type: 'authoring.create', panelId, applicationId, title },
      authoringGuideResultSchema,
    ),
  resume: (panelId) =>
    sendToBackground({ type: 'authoring.resume', panelId }, authoringDoneResultSchema),
  startCapture: (panelId) =>
    sendToBackground(
      { type: 'authoring.capture.start', panelId },
      authoringCaptureStartResultSchema,
    ),
  cancelCapture: (panelId) =>
    sendToBackground({ type: 'authoring.capture.cancel', panelId }, authoringDoneResultSchema),
  takeCapture: (panelId, captureId) =>
    sendToBackground(
      { type: 'authoring.capture.take', panelId, captureId },
      authoringCaptureResultSchema,
    ),
  save: (panelId, operationId, applicationId, guideId, request) =>
    sendToBackground(
      {
        type: 'authoring.save',
        panelId,
        operationId,
        applicationId,
        guideId,
        request: plain(request),
      },
      authoringSaveResultSchema,
    ),
  writeLocal: (panelId, draft, version) =>
    sendToBackground(
      { type: 'authoring.local.write', panelId, draft: plain(draft), version },
      authoringLocalResultSchema,
    ),
  clearLocal: (panelId, guideId, version) =>
    sendToBackground(
      { type: 'authoring.local.clear', panelId, guideId, version },
      authoringDoneResultSchema,
    ),
  showPreview: (panelId, captureId, title, lines) =>
    sendToBackground(
      { type: 'authoring.preview.show', panelId, captureId, title, lines: [...lines] },
      previewResultSchema,
    ),
  hidePreview: (panelId) =>
    sendToBackground({ type: 'authoring.preview.hide', panelId }, authoringDoneResultSchema),
  exit: (panelId, final) =>
    sendToBackground(
      { type: 'authoring.exit', panelId, ...(final && { final: plain(final) }) },
      authoringDoneResultSchema,
    ),
  detach: (panelId, final) => {
    chrome.runtime
      .sendMessage({ type: 'authoring.detach', panelId, ...(final && { final: plain(final) }) })
      .catch(() => undefined)
  },
}
