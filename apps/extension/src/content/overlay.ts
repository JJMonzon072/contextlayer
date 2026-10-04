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
 * - Styles via a constructable stylesheet (`adoptedStyleSheets`), no <style> tag.
 * - Floating UI uses the Popover API, which renders in the browser's top layer,
 *   above any page z-index or `overflow: hidden` container.
 * - The host only exists while there is something to show and carries no
 *   version or other data a page could use to fingerprint the extension.
 */
export const OVERLAY_HOST_ATTRIBUTE = 'data-contextlayer-root'

const OVERLAY_CSS = `
:host {
  all: initial !important;
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
  showToast(text: string, durationMs?: number): void
  destroy(): void
}

interface MountedOverlay {
  host: HTMLElement
  toast: HTMLElement
}

export function createOverlay(doc: Document): Overlay {
  let mounted: MountedOverlay | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  function mount(): MountedOverlay {
    const host = doc.createElement('div')
    host.setAttribute(OVERLAY_HOST_ATTRIBUTE, '')
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
    return { host, toast }
  }

  function unmount() {
    clearTimeout(hideTimer)
    mounted?.host.remove()
    mounted = undefined
  }

  return {
    showToast(text, durationMs = 3_500) {
      // The page may have removed our node (e.g. a framework re-rendering <html>).
      if (!mounted?.host.isConnected) {
        unmount()
        mounted = mount()
      }

      // textContent, never innerHTML: overlay text must not become markup.
      mounted.toast.textContent = text
      if (!mounted.toast.matches(':popover-open')) mounted.toast.showPopover()

      clearTimeout(hideTimer)
      hideTimer = setTimeout(unmount, durationMs)
    },
    destroy: unmount,
  }
}
