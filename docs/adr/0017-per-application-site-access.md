# ADR 0017: Per-application site access with runtime content scripts

- Status: Accepted
- Date: 2026-10-05
- Deciders: JJ

## Context

From Phase 4 the extension must run inside customer applications (`https://crm.acme.example`), not only on the local dashboard. Forces:

- **Least privilege.** A static `content_scripts` entry or `<all_urls>` grants host access to every listed site at install time, with the strongest warning, and an update that widens it disables the extension until the user accepts ([ADR 0007](0007-chrome-manifest-v3-extension.md), R-03).
- **Three separate facts.** An origin can be _registered_ as an application of the workspace (dashboard, API), _turned on_ by this user in this browser, and _granted_ by Chrome. Each can change without the others: an admin deletes the application or edits its origin, the user withdraws access in `chrome://extensions`, the extension switches workspace.
- **Chrome behavior measured in the Phase 4 spike** (Chromium 153.0.8010.12): `permissions.request` only shows its prompt for a user gesture, and the prompt cannot be answered under automation; requesting an origin that is already granted resolves `true` at once. A match pattern without a port matches every port. `registerContentScripts` succeeds without host access (injection still needs it). `tabs.query({ url })` only finds tabs with an explicit host permission. Two `executeScript` calls share one isolated world, so the second sees the first's globals; after an extension reload a new script gets a new world and the old one is orphaned. Registrations made with `persistAcrossSessions` were gone after a browser restart of a command-line-loaded extension. The `chrome://extensions` "Site access" toggle fires `permissions.onRemoved` for every host, the API's included.
- **Content scripts are untrusted** ([ADR 0012](0012-service-worker-api-gateway.md)): their messages may be forged by a compromised renderer.

## Decision

**Implemented (Phase 4).** ContextLayer runs on a page only when all four hold, each checked where it lives:

1. the extension is connected (vault);
2. the user turned the origin on, for the connected workspace (vault, `cl.sites`);
3. the origin belongs to one of the workspace's applications (`GET /v1/extension/applications`, cached in `storage.session`, refreshed when the popup opens and at most every 10 minutes when a page asks);
4. Chrome grants that exact origin (`chrome.permissions.contains`).

**Manifest.** `permissions: storage, scripting, activeTab`; `host_permissions`: the API origin only; `optional_host_permissions: https://*/*, http://*/*`; no static content scripts (the Phase 1 one on the local dashboard is gone).

**Popup.** `src/popup/ApplicationsCard.vue` lists the connection's applications with their origins, each On or Off in this browser, and opens an origin in a new tab. `src/popup/SiteCard.vue` shows, for the active tab, one state: unsupported page (browser pages, files, the Web Store), API access withheld, API unreachable, not registered in the workspace, available (registered, off; Chrome access granted or not), Chrome access removed while on, or active with the published guides (title and step count, no way to play them before Phase 6). "Turn on" calls `chrome.permissions.request` first, inside the click, for the origin with its port pinned (`originMatchPattern`), then asks the worker to record the activation; the worker records it only if the origin is registered and Chrome did grant it. "Turn off" removes the activation and gives Chrome's access back. `activeTab` lets the popup read the tab's address without a grant for every site.

**Reconciliation** (`src/background/site-access.ts`). One idempotent, serialized function turns the four facts into dynamic registrations: id `cl-site-<first 96 bits of SHA-256(origin)>`, `matches` the pinned origin, `allFrames: false`, `runAt: document_idle`, `persistAcrossSessions: true`. It unregisters what is no longer wanted, registers what is missing, injects newly enabled origins into tabs already open on them, and sends `page.deactivate` (with the page's `documentId`) to pages that lost access. Registrations without the `cl-site-` prefix are never touched. Triggers: `runtime.onInstalled` and `runtime.onStartup` (which also re-inject every enabled origin, since registrations may be gone and open tabs hold orphans), `permissions.onAdded`/`onRemoved`, connection changes and site changes. There is no polling. Without a known application list (API down and nothing cached), it keeps what runs and adds nothing.

**Content script** (`src/content/index.ts`). A guard on the isolated world's global makes a second injection a no-op. The script stays inert until the worker answers `page.hello`, the only message a content script may send: the worker decides from Chrome's sender fields alone (top frame, a `documentId`, `sender.origin` equal to the URL's origin, the four facts) and answers `{ active }`, nothing more. `page.deactivate` stops it for good. A copy orphaned by a reload or update checks `chrome.runtime.id` on `visibilitychange` and `pageshow` and stops; a new copy removes UI hosts an orphan left in the DOM. Content scripts never read credentials: `chrome.storage` is closed to them ([ADR 0015](0015-authentication-strategy.md)).

**Lifetimes.** Activations belong to one workspace and are cleared on disconnect or when the connection ends; switching workspace leaves the other workspace's list unused. Chrome grants are given back only when the user turns a site off: after a disconnect they stay in Chrome but nothing runs without an activation.

## Alternatives considered

- **Static `content_scripts` for every customer origin.** Known in advance only per deployment, and grants at install time with a warning on every change. Why not: least privilege and update friction.
- **`<all_urls>` with an in-script allow-list.** Why not: the strongest install warning, and the script would run on every page before deciding not to.
- **`activeTab` only, injecting on each popup click.** No standing grant. Why not: nothing would run on navigation or in new tabs, which the player (Phase 6) needs.
- **React only in the popup.** Why not: the popup may close when Chrome shows its prompt, and permission changes made in `chrome://extensions` never reach it; the worker's events do.
- **A DOM event to hand over from an orphan to a new copy.** Why not: page scripts can observe and forge it, and fingerprint the extension; the orphan can detect itself.

## Consequences

- **Positive:** the install-time grant is the API origin alone; each customer origin is granted by a click, only for registered applications; every change converges through one function that the unit tests drive with a fake Chrome and the e2e suite checks in Chromium.
- **Negative:** an application deleted or an origin edited in the dashboard is noticed when the popup opens or a page asks after the cache expires, not instantly. The application list is bounded at 100 per workspace. Chrome's prompt cannot be automated: the e2e build pre-grants one stand-in site, so the popup's real request resolves without a prompt there.
- **Manual check** (not automatable, not run by the test suites): load the regular build unpacked, connect, register an application for a site not granted yet, open it, click "Turn on for this site". Chrome shows its prompt for that origin only. "Allow" → the popup shows the site as on with its guides; "Deny" → the popup says Chrome did not allow access and the site stays off; nothing runs on it.
- **Follow-ups:** **Proposed:** `permissions.addHostAccessRequest` (Chrome 133+) to ask again from the page when access was withheld. **Planned (Phase 6):** the player uses the same `page.hello` gate and reads guides through the worker.

## References

- Declare permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- `chrome.permissions`: https://developer.chrome.com/docs/extensions/reference/api/permissions
- `chrome.scripting.registerContentScripts`: https://developer.chrome.com/docs/extensions/reference/api/scripting#method-registerContentScripts
- Match patterns: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
- `activeTab`: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
