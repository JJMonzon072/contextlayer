import type { CalloutContent, Overlay } from './overlay'

/**
 * Edit Mode's preview of one draft step (Phase 5): the element the author
 * selected on this page, highlighted, with the step's title and instructions
 * next to it and a close button. It uses the element kept in memory when it
 * was selected, never a lookup: if that element is gone, there is nothing to
 * preview until it is selected again. No Next/Previous/Finish, no analytics,
 * and the tag says it is a draft, not a published guide. Text only, through
 * the isolated overlay.
 */

export const PREVIEW_TAG = 'Preview · draft step, not published'

export interface PreviewDeps {
  window: Window
  overlay: Overlay
  element: Element
  title: string
  lines: string[]
  /** The author closed it from the page. */
  onClose: () => void
}

export interface Preview {
  stop(): void
}

/** `undefined` when the element is no longer on the page. */
export function showPreview(deps: PreviewDeps): Preview | undefined {
  const { window, overlay, element } = deps
  if (!element.isConnected) return undefined
  let frame: number | undefined
  let stopped = false
  const content: CalloutContent = {
    tag: PREVIEW_TAG,
    title: deps.title.trim() === '' ? 'Untitled step' : deps.title,
    lines: deps.lines,
    onClose: () => {
      stop()
      deps.onClose()
    },
  }

  function draw() {
    frame = undefined
    if (stopped) return
    if (!element.isConnected) {
      stop()
      return
    }
    const box = element.getBoundingClientRect()
    const rect = { left: box.left, top: box.top, width: box.width, height: box.height }
    overlay.highlight(rect)
    overlay.callout(content, rect)
  }

  function schedule() {
    frame ??= window.requestAnimationFrame(draw)
  }

  function stop() {
    if (stopped) return
    stopped = true
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule, true)
    overlay.highlight(null)
    overlay.callout(null)
  }

  element.scrollIntoView({ block: 'center', inline: 'nearest' })
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule, true)
  draw()
  return { stop }
}
