/**
 * Root of every piece of UI ContextLayer injects into a host page.
 *
 * Isolation strategy (see docs/adr/0013-shadow-dom-ui-isolation.md):
 * - The host is a plain <div>, never a custom element: a page could define a
 *   custom element with our tag before we run and reach the shadow root through
 *   `ElementInternals`. Built-in elements cannot be redefined by the page.
 * - CLOSED shadow root: page scripts cannot reach our UI through `host.shadowRoot`.
 * - `:host { all: initial !important }` stops page styles (font, color, even
 *   `div { display: none }`) from leaking into or hiding the host.
 * - Sizes in px, not rem: rem follows the page's root font-size.
 * - Styles via a constructable stylesheet (`adoptedStyleSheets`), no <style>
 *   tag and no style attribute, so a strict `style-src` does not block them;
 *   positions are set through the CSSOM (`element.style.left`), which CSP
 *   allows.
 * - Floating UI uses the Popover API, which renders in the browser's top layer,
 *   above any page z-index or `overflow: hidden` container.
 * - Nothing we draw takes pointer events (`pointer-events: none`), and the
 *   picker's hit test skips the host anyway, so the page element under the
 *   pointer is always the one found.
 * - Text is set with `textContent` only, never parsed as markup.
 * - The host only exists while there is something to show and carries no
 *   version or other data a page could use to fingerprint the extension.
 */
export const OVERLAY_HOST_ATTRIBUTE = 'data-contextlayer-root'

const FONT = `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`

const OVERLAY_CSS = `
:host {
  all: initial !important;
  pointer-events: none !important;
}

[popover] {
  margin: 0;
  padding: 0;
  border: 0;
  inset: auto;
  overflow: visible;
  pointer-events: none;
  box-sizing: border-box;
  background: transparent;
  color: inherit;
}

.toast {
  inset: auto 16px 16px auto;
  max-width: 320px;
  padding: 10px 14px;
  border-radius: 10px;
  background: #1e1b4b;
  color: #ffffff;
  font: 500 13px/1.45 ${FONT};
  box-shadow: 0 10px 30px rgb(15 23 42 / 0.25);
}

.box {
  border: 2px solid #4f46e5;
  border-radius: 4px;
  background: rgb(79 70 229 / 0.12);
  box-shadow: 0 0 0 1px #ffffff;
}

.label {
  max-width: 360px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #1e1b4b;
  color: #ffffff;
  font: 600 12px/1.6 ${FONT};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.callout {
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 12px 14px;
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  background: #ffffff;
  color: #0f172a;
  font: 400 13px/1.5 ${FONT};
  box-shadow: 0 12px 32px rgb(15 23 42 / 0.25);
  pointer-events: auto;
}

.callout .tag {
  display: block;
  color: #4338ca;
  font: 600 11px/1.4 ${FONT};
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.callout .title {
  display: block;
  margin: 4px 0 0;
  font: 600 14px/1.4 ${FONT};
  overflow-wrap: anywhere;
}

.callout .line {
  display: block;
  margin: 6px 0 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.callout .close {
  margin: 10px 0 0;
  padding: 6px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #ffffff;
  color: #0f172a;
  font: 500 12px/1 ${FONT};
  cursor: pointer;
}

.callout .close:focus-visible {
  outline: 2px solid #4f46e5;
  outline-offset: 2px;
}

.banner {
  inset: 12px auto auto 12px;
  max-width: 420px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #1e1b4b;
  color: #ffffff;
  font: 500 13px/1.45 ${FONT};
  box-shadow: 0 10px 30px rgb(15 23 42 / 0.25);
}
`

export interface HighlightRect {
  left: number
  top: number
  width: number
  height: number
}

export interface CalloutContent {
  /** A short tag above the title, e.g. "Preview · draft step". */
  tag: string
  title: string
  lines: string[]
  onClose: () => void
}

export interface Overlay {
  showToast(text: string, durationMs?: number): void
  /** A box of text next to `rect`, with a close button; `null` hides it. */
  callout(content: CalloutContent | null, rect?: HighlightRect): void
  /** Draws a box around `rect` (viewport coordinates) with a short label; `null` hides it. */
  highlight(rect: HighlightRect | null, label?: string): void
  /** A persistent notice at the top of the page; `null` hides it. */
  banner(text: string | null): void
  /** True for our own host: hit tests and pickers skip it. */
  isOwn(node: Node): boolean
  destroy(): void
}

interface MountedOverlay {
  host: HTMLElement
  toast: HTMLElement
  box: HTMLElement
  label: HTMLElement
  banner: HTMLElement
  callout: HTMLElement
}

export function createOverlay(doc: Document): Overlay {
  let mounted: MountedOverlay | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let toastVisible = false
  /** The content on screen: repositioning does not rebuild it (focus stays on its button). */
  let shownCallout: CalloutContent | undefined

  function fillCallout(callout: HTMLElement, content: CalloutContent) {
    shownCallout = content
    const part = (tag: string, className: string, text: string) => {
      const element = doc.createElement(tag)
      element.className = className
      element.textContent = text
      return element
    }
    const close = part('button', 'close', 'Close preview')
    close.setAttribute('type', 'button')
    close.addEventListener('click', content.onClose)
    callout.replaceChildren(
      part('span', 'tag', content.tag),
      part('strong', 'title', content.title),
      ...content.lines.map((line) => part('span', 'line', line)),
      close,
    )
  }

  function mount(): MountedOverlay {
    const host = doc.createElement('div')
    host.setAttribute(OVERLAY_HOST_ATTRIBUTE, '')
    const shadow = host.attachShadow({ mode: 'closed' })

    const sheet = new CSSStyleSheet()
    sheet.replaceSync(OVERLAY_CSS)
    shadow.adoptedStyleSheets = [sheet]

    const part = (className: string, role?: string) => {
      const element = doc.createElement('div')
      element.className = className
      element.popover = 'manual'
      if (role) element.setAttribute('role', role)
      shadow.append(element)
      return element
    }
    const box = part('box')
    const label = part('label')
    const banner = part('banner', 'status')
    const callout = part('callout', 'dialog')
    callout.setAttribute('aria-label', 'ContextLayer step preview')
    const toast = part('toast', 'status')

    // documentElement survives SPA frameworks that replace <body> content.
    doc.documentElement.append(host)
    return { host, toast, box, label, banner, callout }
  }

  /** The page may have removed our node (e.g. a framework re-rendering <html>). */
  function ensure(): MountedOverlay {
    if (!mounted?.host.isConnected) {
      mounted?.host.remove()
      mounted = mount()
      shownCallout = undefined
    }
    return mounted
  }

  const show = (element: HTMLElement) => {
    element.showPopover()
  }
  const hide = (element: HTMLElement | undefined) => {
    if (element?.matches(':popover-open')) element.hidePopover()
  }

  function unmount() {
    clearTimeout(hideTimer)
    mounted?.host.remove()
    mounted = undefined
    toastVisible = false
    shownCallout = undefined
  }

  /** Removes the host once nothing is shown, so an idle page carries no node of ours. */
  function unmountIfIdle() {
    if (!mounted) return
    const { box, banner, callout } = mounted
    const open = [box, banner, callout].some((element) => element.matches(':popover-open'))
    if (!toastVisible && !open) unmount()
  }

  return {
    showToast(text, durationMs = 3_500) {
      const { toast } = ensure()
      toast.textContent = text
      if (!toast.matches(':popover-open')) toast.showPopover()
      toastVisible = true
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        toastVisible = false
        hide(mounted?.toast)
        unmountIfIdle()
      }, durationMs)
    },

    highlight(rect, text = '') {
      if (!rect) {
        hide(mounted?.box)
        hide(mounted?.label)
        unmountIfIdle()
        return
      }
      const { box, label } = ensure()
      box.style.left = `${String(rect.left)}px`
      box.style.top = `${String(rect.top)}px`
      box.style.width = `${String(Math.max(rect.width, 4))}px`
      box.style.height = `${String(Math.max(rect.height, 4))}px`
      if (!box.matches(':popover-open')) show(box)
      if (text === '') {
        hide(label)
        return
      }
      label.textContent = text
      // Above the box when there is room, otherwise just inside its top edge.
      label.style.left = `${String(Math.max(rect.left, 0))}px`
      label.style.top = `${String(rect.top >= 24 ? rect.top - 24 : Math.max(rect.top, 0) + 2)}px`
      if (!label.matches(':popover-open')) show(label)
    },

    banner(text) {
      if (text === null) {
        hide(mounted?.banner)
        unmountIfIdle()
        return
      }
      const { banner } = ensure()
      banner.textContent = text
      if (!banner.matches(':popover-open')) show(banner)
    },

    callout(content, rect) {
      if (!content) {
        shownCallout = undefined
        hide(mounted?.callout)
        unmountIfIdle()
        return
      }
      const { callout } = ensure()
      if (content !== shownCallout) fillCallout(callout, content)
      if (!callout.matches(':popover-open')) show(callout)
      // Below the element when it fits, otherwise above it; always inside the viewport.
      const view = doc.defaultView
      const width = view?.innerWidth ?? 1024
      const height = view?.innerHeight ?? 768
      const box = callout.getBoundingClientRect()
      const target = rect ?? { left: 12, top: 12, width: 0, height: 0 }
      const below = target.top + target.height + 10
      const top = below + box.height <= height ? below : Math.max(12, target.top - box.height - 10)
      const left = Math.min(Math.max(12, target.left), Math.max(12, width - box.width - 12))
      callout.style.left = `${String(left)}px`
      callout.style.top = `${String(Math.min(top, Math.max(12, height - box.height - 12)))}px`
    },

    isOwn: (node) =>
      mounted !== undefined && (node === mounted.host || mounted.host.contains(node)),
    destroy: unmount,
  }
}
