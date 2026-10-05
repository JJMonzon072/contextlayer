/**
 * The two chrome.storage areas the service worker uses (ADR 0015):
 * - `session`: in memory, readable by trusted contexts only by default. Holds the
 *   PKCE attempt, the access token and caches; cleared when the browser closes.
 * - `local`: on disk. Content scripts can read it unless the worker restricts it
 *   with `setAccessLevel(TRUSTED_CONTEXTS)`; the spike showed the restriction
 *   persists across worker and browser restarts. The refresh token goes there
 *   only after the restriction succeeded; otherwise it stays in `session`.
 */
export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export interface ExtensionStorage {
  local: StorageArea
  session: StorageArea
  /** Resolves true once `local` is restricted to trusted contexts. */
  restrictLocal(): Promise<boolean>
}

export function chromeStorage(): ExtensionStorage {
  return {
    local: chrome.storage.local,
    session: chrome.storage.session,
    restrictLocal: () =>
      chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(
        () => true,
        () => false,
      ),
  }
}
