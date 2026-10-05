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

**Popup.** `src/popup/ApplicationsCard.vue` lists the connection's applications with their origins, each On or Off in this browser, and opens an origin in a new tab. `src/popup/SiteCard.vue` shows, for the active tab, one state: unsupported page (browser pages, files, the Web Store), API access withheld, API unreachable, not registered in the workspace, available (registered, off; Chrome access granted or not), Chrome access removed while on, or active with the published guides (title and step count, no way to play them before Phase 6). "Turn off" removes the activation and gives Chrome's access back. `activeTab` lets the popup read the tab's address without a grant for every site.

**"Turn on" outlives the popup** (changed after the Phase 4 review of `5ed6613`, which found that the popup waited for Chrome's answer before telling the worker, so a popup closed while the prompt was open could leave the origin granted but never turned on). In the click's task, synchronously, the popup:

1. sends `site.requestActivation` to the worker without waiting for its answer;
2. calls `chrome.permissions.request()` for the origin with its port pinned (`originMatchPattern`).

The worker stores a pending request in `storage.session`: the connection (grant) and workspace, the exact origin and pattern, the tab, and an expiry of 3 minutes; a newer request replaces it. The reconciliation completes it, at most once, when Chrome has granted that origin: at once if it already had, on `permissions.onAdded`, or when the popup asks for the status. Before turning the site on it checks again that the request has not lapsed, that the connection is the same, that the tab still shows that origin (a navigation drops the request: no other origin is ever turned on), that Chrome grants it and that it is still registered; the activation is written in a life-cycle transition ([ADR 0015](0015-authentication-strategy.md)), so Disconnect cannot slip in before the write. A refusal seen by the popup cancels the request; Disconnect, another connection, "Turn off" and expiry drop it. A grant made outside such a request, for instance in `chrome://extensions`, turns nothing on. If the popup was already closed when the user refused, the request waits until it lapses; granting that site in `chrome://extensions` within those 3 minutes completes it, since the user did ask for it.

Measured in this repository's harness (Playwright's Chromium 153.0.8010.12, new headless; user activation simulated with CDP `Runtime.evaluate({ userGesture })`, not a real click): without activation, `permissions.request()` for an origin not yet granted is refused ("This function must be called during a user gesture"), while an origin already granted resolves `true` even without activation; with activation, a request made after a 6-second wait is refused, so activation expires with time. A request made after awaiting a round trip to the worker still went through, but the popup does not rely on that timing: it sends the message and asks Chrome in the same task, and that order was measured to still reach the prompt. In this harness the toolbar popup stayed open for 3 seconds after the prompt appeared; the closure reported in [Chromium issue 40721470](https://issues.chromium.org/issues/40721470) was not reproduced here, and the design does not depend on it, since a user can always close the popup.

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
- **Negative:** an application deleted or an origin edited in the dashboard is noticed when the popup opens or a page asks after the cache expires, not instantly. The application list is bounded at 100 per workspace. Chrome's prompt was not automated in this harness: the prompt for an origin not yet granted stayed open and the means tried did not answer it (the `--apps-gallery-install-auto-confirm-for-tests` switch, spike item 8), and the toolbar popup can only be opened there with `chrome.action.openPopup()`, which grants no `activeTab`, so the popup cannot even see the address of a site without access. Other setups (a headed browser driven at the OS level, for instance) were not tried. The e2e build therefore pre-grants one stand-in site, where the popup's real request resolves without a prompt; those tests show the worker's side, not the prompt.
- **Manual check:** Chrome's own prompt is checked by hand, with the procedure below. Status: **not run yet** (pending for JJ); the automated suites do not cover it.
- **Follow-ups:** **Proposed:** `permissions.addHostAccessRequest` (Chrome 133+) to ask again from the page when access was withheld. **Planned (Phase 6):** the player uses the same `page.hello` gate and reads guides through the worker.

### Manual check of Chrome's permission prompt

Use the regular build, not the e2e one, in a Chrome or Chromium profile where the sites below were never granted. Do not open the popup's DevTools: the point is its normal life cycle.

Setup:

1. `pnpm dev` (API, dashboard and `apps/extension/dist`), then `chrome://extensions` → Developer mode → **Load unpacked** → `apps/extension/dist`; pin ContextLayer.
2. Serve two empty test sites that no extension has access to: `python3 -m http.server 8081` and, in another terminal, `python3 -m http.server 8082`.
3. In the dashboard, in one workspace, register two applications, `http://localhost:8081` and `http://localhost:8082`, and publish one guide for each.
4. Click the ContextLayer icon → **Connect to ContextLayer** → approve in the dashboard. The popup shows the workspace and both applications, Off.

Allow:

5. Open `http://localhost:8081`, click the ContextLayer icon in the toolbar (the real icon), and click **Turn on for this site**.
6. Chrome asks for access to `localhost:8081` only. Click **Allow**. If the popup closed, leave it closed.
7. Click the icon again. Expected: "On for …" with the published guide; Applications shows `http://localhost:8081` On; **Check this page** answers "Running on this page." and shows a toast on the page.

Deny, in clean conditions (the second site was never granted nor turned on):

8. Open `http://localhost:8082`, click the icon, **Turn on for this site**, and click **Deny** (or close the prompt).
9. Reopen the popup if it closed. Expected: the site is still off ("Chrome will ask you to allow access to this site only." and the **Turn on** button, no guides and no **Check this page**); Applications shows `http://localhost:8082` Off; if the popup stayed open it said that Chrome did not allow access.
10. Reload the page: no toast, nothing from ContextLayer. If `chrome://extensions` → ContextLayer → Details lists the sites ContextLayer may access, `localhost:8082` is not among them. After 3 minutes, reopen the popup: still off (the request lapsed).

Record the Chrome version and the outcome of steps 7, 9 and 10 in the roadmap when the check is run.

## References

- Declare permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- `chrome.permissions`: https://developer.chrome.com/docs/extensions/reference/api/permissions
- `chrome.scripting.registerContentScripts`: https://developer.chrome.com/docs/extensions/reference/api/scripting#method-registerContentScripts
- Match patterns: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
- `activeTab`: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
