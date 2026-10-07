/**
 * Same-document navigation in the page (Phase 6b, ADR 0019): the Navigation
 * API's `currententrychange` covers `pushState`, `replaceState`, the hash and
 * back / forward, and reaches the isolated world (measured in Chromium).
 * Where `navigation` is missing, `popstate` and `hashchange` stand in (they
 * miss `pushState` and `replaceState`). No patching of the page's `history`,
 * no polling. Returns the function that stops listening.
 */
export function followNavigation(window: Window, onChange: () => void): () => void {
  // Typed as always there by lib.dom; checked anyway, since it is the fallback's reason.
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation
  const changed = () => {
    onChange()
  }
  if (navigation) {
    navigation.addEventListener('currententrychange', changed)
    return () => {
      navigation.removeEventListener('currententrychange', changed)
    }
  }
  window.addEventListener('popstate', changed)
  window.addEventListener('hashchange', changed)
  return () => {
    window.removeEventListener('popstate', changed)
    window.removeEventListener('hashchange', changed)
  }
}
