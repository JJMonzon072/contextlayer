/**
 * Keyboard commands (`chrome.commands`), shared by the manifest and the worker.
 *
 * `focus-guide` moves the focus to the Guide Player's card on the active tab
 * (Phase 6b, ADR 0013). Suggested keys: Alt+Shift+G on Windows, Linux and
 * ChromeOS, Control+Shift+G on macOS (`MacCtrl`, so typing with Option is not
 * taken). Chrome handles the key before the page, even in a text field, and
 * users can change or remove it in chrome://extensions/shortcuts.
 */
export const FOCUS_GUIDE_COMMAND = 'focus-guide'

export const FOCUS_GUIDE_KEYS = { default: 'Alt+Shift+G', mac: 'MacCtrl+Shift+G' } as const
