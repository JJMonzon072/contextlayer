# ADR 0018: The side panel as Edit Mode's authoring surface

- Status: Accepted
- Date: 2026-10-05
- Deciders: JJ

## Context

Edit Mode (Phase 5) lets an editor build a guide on the customer application itself: choose a guide, add steps, point each one at an element of the page and save the draft. The author types titles and instructions, sees what will be stored, and saves. Three forces shape where that UI lives:

- **The page is untrusted.** Anything typed into the page's DOM can be read by the page's scripts, including in a closed shadow root (keyboard events bubble to the host; ADR 0013). Text inputs inside the page would hand the author's draft to a third-party application.
- **The popup closes** as soon as it loses focus, and clicking the page to pick an element takes the focus away.
- **Only the service worker calls the API** ([ADR 0012](0012-service-worker-api-gateway.md)), and content scripts never hold credentials ([ADR 0017](0017-per-application-site-access.md)).

Facts measured in a spike on 2026-10-05 (Playwright's Chromium 153, new headless mode):

- the `sidePanel` permission alone is enough; no `side_panel` manifest key is needed;
- from a popup click, `chrome.sidePanel.setOptions({ tabId, path, enabled: true })` (not awaited) followed by `chrome.sidePanel.open({ tabId })` in the same task opens the panel; awaiting a message before `open()` risks losing the click's user activation;
- the panel document stays alive when the author switches tabs, and its runtime messages carry `sender.url` = `sidepanel.html?tab=…` and no `sender.tab`;
- `setOptions({ tabId, enabled: false })` closes a tab's panel; the panel page is reachable from Playwright through a CDP connection made after it exists.

`minimum_chrome_version` is 120: `sidePanel` exists since Chrome 114 and `open()` since 116; `sidePanel.onClosed` (Chrome 142) and `close()` (141) are newer and are only used when present.

## Decision

**Implemented (Phase 5).**

- **A tab-specific side panel** (`apps/extension/sidepanel.html`, Vue 3, `src/sidepanel/`). The extension's global panel is disabled on install; the popup's **Edit Mode** button (shown only when the site card is `active`) enables the panel for its tab with `?tab=<id>` and opens it in the click's task. The panel is not a web-accessible resource.
- **All authoring input lives in the panel.** The page only gets the picker's highlight and a preview callout, both text-only and without inputs ([ADR 0013](0013-shadow-dom-ui-isolation.md)).
- **One Edit Mode session**, kept by the worker in `storage.session` (`src/background/authoring.ts`), bound to the connection (grant and workspace), the panel that attached (`panelId`, issued by the worker), the tab, its origin and the document (`documentId`) of its current content script, the open guide and at most one capture request. A newer panel takes the session over; the older one is told it moved. The router tells the panel (`/sidepanel.html`) apart from the popup by Chrome's `sender.url` and accepts `authoring.*` only from it; content scripts may only send `picker.result` and `picker.cancelled` for the current request.
- **Capture under a request id.** The panel asks; the worker checks the session, creates a `captureId` (2-minute limit) and sends `picker.start` to the bound document only (`tabs.sendMessage` with `documentId`). The content script answers that id once; the worker accepts it only from that tab's top frame, document and origin, before it expires, parses the descriptor with the shared schema, stores it, and sends a data-less `authoring.changed`; the panel then asks for it. A forged copy of that notice can only trigger a refresh.
- **Review before use, save on request.** A captured target waits in the panel for "Use this element"; nothing is saved until the author saves. Saves go through the worker to `PUT …/steps` with the revision the edits started from ([API](../api.md)); the answer is applied only if the connection, the session and the guide are still the ones it was sent for.
- **Life cycle.** A reload or navigation pauses selection until the author clicks **Continue on this page**; Disconnect, a replaced connection, a site turned off or withdrawn in Chrome, a closed tab, Exit and a closed panel end the session and stop any picker or preview. The panel signals its own closing from `pagehide` (and `sidePanel.onClosed` where available); the 2-minute capture limit bounds a picker whose panel vanished silently. There are no ports, timers or polling in the worker: the session survives the worker stopping between events, and the e2e suite stops the worker between a request and the click.
- **Unsaved changes** are copied to `storage.session` through the worker (bound to grant, workspace, guide and base revision; at most 2 MiB; cleared with the connection) and offered back when the guide is opened again. Chrome clears `storage.session` when the browser closes and when the extension is updated, reloaded or disabled, so they are lost then, and the panel says so; only a save keeps them.

## Alternatives considered

- **Editor inside the page (shadow DOM).** Familiar from other tools. Why not: page scripts would observe every keystroke, strict CSPs and hostile styles would fight a much larger UI, and focus would be shared with the application.
- **The popup.** Already exists. Why not: it closes when the author clicks the page, which is the main interaction.
- **A separate window or tab.** Survives focus changes. Why not: it loses the visual link to the page, and window management is clumsy next to the application.
- **Content script talking to the panel directly** (`runtime.sendMessage` both ways). Why not: content scripts can message extension pages, so the panel would have to trust page-originated messages; routing through the worker lets it check Chrome's sender fields and the session.

## Consequences

Positive:

- Drafts never touch the page's DOM; the page only sees what the author previews.
- Every capture and save is bound to one session and one request, so late or forged answers are dropped (unit tests with controlled promises and Playwright scenarios).

Negative / trade-offs:

- One Edit Mode session per browser at a time.
- Without `sidePanel.onClosed` (Chrome < 142), closing the panel is noticed through `pagehide`, which is best effort; a picker left behind stops at its 2-minute limit or with Escape.
- A preview needs the element selected on the current page; a step loaded from the server is never looked up (that is the Phase 6 resolver), so it asks to be selected again.
- Opening needs a real click in the popup; there is no keyboard shortcut yet.

Follow-ups:

- **Proposed:** a command shortcut to open Edit Mode; a manual check in Chrome 120 (only Chromium 153 was tested).

## References

- `chrome.sidePanel`: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- User activation: https://developer.mozilla.org/en-US/docs/Web/Security/User_activation
- `tabs.sendMessage` with `documentId`: https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage
