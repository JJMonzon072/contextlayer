/**
 * Root of every piece of UI ContextLayer injects into a host page.
 *
 * Isolation strategy (see docs/adr/0013-shadow-dom-ui-isolation.md):
 * - A custom element host with a CLOSED shadow root: page CSS cannot style our
 *   UI and page scripts cannot reach into it through `host.shadowRoot`.
 * - `:host { all: initial }` stops inherited page styles (font, color...) leaking in.
 * - Sizes in px, not rem: rem follows the page's root font-size.
 * - Styles via a constructable stylesheet (`adoptedStyleSheets`), no <style> tag.
 * - Floating UI uses the Popover API, which renders in the browser's top layer,
 *   above any page z-index or `overflow: hidden` container.
 */
export const OVERLAY_HOST_TAG = 'contextlayer-root'

const OVERLAY_CSS = `
:host {
  all: initial;
}

.toast {
  position: fixed;
  inset: auto 16px 16px auto;
  margin: 0;
  max-width: 320px;
  padding: 10px 14px;
  border: 0;
  border-radius: 10px;
  background: #1e1b4b;
  color: #ffffff;
  font: 500 13px/1.45 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  box-shadow: 0 10px 30px rgb(15 23 42 / 0.25);
}
`

export interface Overlay {
  readonly host: HTMLElement
  showToast(text: string, durationMs?: number): void
  destroy(): void
}

export function mountOverlay(doc: Document, version: string): Overlay {
  // A host left by a previous instance (e.g. an orphaned content script after
  // an extension update) is replaced instead of duplicated.
  doc.querySelector(OVERLAY_HOST_TAG)?.remove()

  const host = doc.createElement(OVERLAY_HOST_TAG)
  host.dataset.contextlayerVersion = version
  const shadow = host.attachShadow({ mode: 'closed' })

  const sheet = new CSSStyleSheet()
  sheet.replaceSync(OVERLAY_CSS)
  shadow.adoptedStyleSheets = [sheet]

  const toast = doc.createElement('div')
  toast.className = 'toast'
  toast.popover = 'manual'
  toast.setAttribute('role', 'status')
  shadow.append(toast)

  // documentElement survives SPA frameworks that replace <body> content.
  doc.documentElement.append(host)

  let hideTimer: ReturnType<typeof setTimeout> | undefined

  return {
    host,
    showToast(text, durationMs = 3_500) {
      // textContent, never innerHTML: overlay text must not become markup.
      toast.textContent = text
      if (!toast.matches(':popover-open')) toast.showPopover()

      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        if (toast.matches(':popover-open')) toast.hidePopover()
      }, durationMs)
    },
    destroy() {
      clearTimeout(hideTimer)
      host.remove()
    },
  }
}
