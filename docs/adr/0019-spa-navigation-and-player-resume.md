# ADR 0019: Following navigation and resuming a guide in the page

- Status: Accepted (Phase 6b)
- Date: 2026-10-07
- Deciders: JJ

## Context

A guide that has started must follow the user through the application ([R-05](../technical-risks.md), [R-06](../technical-risks.md)). Phase 6a resolved each step once, on the page as it was, and ended the run when the tab loaded a new document. Real applications break both assumptions:

- single-page applications change routes with `history.pushState`, `replaceState`, the hash, and back and forward, without a new document;
- a step of the same guide can live on another page, reached by a link or a form, which loads a new document (or a reload does);
- Chrome's back/forward cache (bfcache) brings a previous document back as it was, without running the content script again;
- an application can open a modal `<dialog>`, which makes everything outside it inert.

The extension must keep its guarantees while following all of this: the worker is the only API caller, a page only drives its own tab's run, nothing old comes back, and nothing is guessed. Chrome's `webNavigation` permission would report every navigation to the worker, but it adds the "Read your browsing history" install warning for every user. MV3 content scripts run in an isolated world, so patching the page's `history` functions from there does not see the page's own calls.

## Measurements (spike, 2026-10-07)

A scratch extension (a content script in the isolated world, a worker logging `sender.documentId`) was run on two local pages in the Chromium of Playwright 1.63, with Playwright's `--disable-back-forward-cache` switch removed. Nothing of it was committed; the results are recorded here.

| Case                                              | What the isolated world saw                                                                                                        | Document                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Navigation API                                    | `navigation` exists in the isolated world                                                                                          |                                           |
| Main-world `history.pushState`                    | `navigate` (`push`, same document), then `currententrychange` (`push`)                                                             | same                                      |
| `history.replaceState`                            | `navigate` / `currententrychange` (`replace`)                                                                                      | same                                      |
| Hash change                                       | `navigate` (`push`, `hashChange`), `currententrychange` (`push`), `popstate`, `hashchange`                                         | same                                      |
| Back / forward within the document                | `navigate` / `currententrychange` (`traverse`), `popstate`, `hashchange`                                                           | same                                      |
| Link, `location.href`, form (hard navigation)     | `navigate` (not same document) in the old document; a new content script runs in the new one                                       | new `documentId`                          |
| Reload                                            | a new content script                                                                                                               | new `documentId`                          |
| Back to a page in bfcache                         | `pagehide` (`persisted: true`) when it was left, `pageshow` (`persisted: true`) when it came back; the script is **not** run again | same `documentId`; our UI still on screen |
| `tabs.sendMessage` to a document in bfcache       | no answer and no rejection within 2 s                                                                                              |                                           |
| The application replaces `document.body`          | our host on `documentElement` stays connected                                                                                      | same                                      |
| `dialog.showModal()` over our card                | our card is under the dialog in the top layer and cannot take focus; outside elements still pass `checkVisibility()`               | same                                      |
| Our host moved into the open dialog               | its popovers close; shown again, the card is on top and focusable; after `close()` it must move back                               | same                                      |
| A `chrome.commands` key pressed through CDP input | `onCommand` does not fire (CDP input does not reach the browser's accelerators)                                                    |                                           |

Our content script did not prevent bfcache (no `notRestoredReasons`): it uses one-shot messages, no ports and no `unload` listener.

## Decision

1. **No `webNavigation`, no new permission, no patching, no polling.** The content script follows navigation in its own document with the Navigation API's `currententrychange` (all same-document cases above), and falls back to `popstate` and `hashchange` where `navigation` is missing (not expected: the extension requires Chrome 120, the API shipped in 102). A DOM mutation is never taken for a navigation.
2. **Same-document navigation is the page's business.** On `currententrychange` the player cancels any resolution or wait in progress and shows the current step again: its effective page pattern (the step's own, else its target's) is matched against the new URL, then the target is resolved and, if needed, waited for. The run, its id, its step and its generation do not change; the worker is not involved.
3. **A step on another page waits for navigation.** When the current step's pattern does not match, the card is shown on its own with "This step is on another page. Navigate there to continue." It is never skipped, ended or replaced by another step: the user navigates, and the step is shown again when the URL matches. The pattern or URL is never displayed.
4. **A new document asks for its tab's run.** Every document that the worker authorizes with `page.hello` then sends `player.resume`. The worker answers with the current step of that tab's run and binds the run to the asking document, after checking in one transition that the run's connection (grant and workspace) is still the stored one, that the document is the one `page.hello` authorized for that tab, and that the run's application is registered for the document's origin (`page.hello` has already checked that the site is turned on, granted by Chrome and registered). Binding means a new `documentId` (and origin, for another origin of the same application) and the next generation. The previous document becomes stale at once: its `player.go` and `player.end` no longer match the run's document, and a step it was sent belongs to an older generation. The resumed step is the current one, never step 1. Resuming first makes the bearer check of Previous and Next (`GET /v1/extension/session`): a revoked connection ends the runs instead of following the user; an unreachable API does not.
5. **Reload is a new document like any other.** A reload during a guide resumes the current step (Phase 6a ended the run).
6. **Origins.** A run continues on another origin only if it is an origin of the same application that the user turned on and Chrome granted, where the content script was authorized. Playback never asks for access and never turns a site on. On a page where ContextLayer is not active, nothing runs. The run stays bound to its last document until the tab comes back to a page of the application, closes, or another guide starts there. A page of another application ends the run.
7. **bfcache.** On `pagehide` with `persisted`, the player removes its UI and stops waiting and observing, without marking the run as ended. On `pageshow` with `persisted`, the content script sends `page.hello` again (the worker records the restored document) and then `player.resume`, which binds the run back to that document. A frozen page sends nothing, and the document left behind becomes stale. The worker never awaits a page's answer without a bound, since a message to a cached document is never answered. No `unload` listener is added, so bfcache stays usable.
8. **Modal dialogs.** While a modal `<dialog>` is open (`dialog:modal`), candidates outside it are left out, since modality makes them inert though they still pass `checkVisibility()`. The overlay's host moves into the open modal dialog and shows its parts again on top. It moves back to `documentElement` when the dialog closes ([ADR 0013](0013-shadow-dom-ui-isolation.md), [ADR 0014](0014-element-targeting-strategy.md)).

Waiting for late targets and re-resolving a target that went away are part of resolution ([ADR 0014](0014-element-targeting-strategy.md)). The keyboard shortcut into the card and focus restore are part of the injected UI ([ADR 0013](0013-shadow-dom-ui-isolation.md)).

## Alternatives considered

| Option                                                   | Why not                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webNavigation` (`onHistoryStateUpdated`, `onCommitted`) | A browsing-history install warning for every user, and the content script still has to act in the page; the Navigation API gives the same signals without a permission.        |
| Patching `history.pushState` / `replaceState`            | From the isolated world it does not see the page's calls; doing it in the main world would mean running code in the page's world.                                              |
| Polling `location.href`                                  | Constant work on every page, and late; the events exist.                                                                                                                       |
| Treating DOM mutations as navigation                     | Applications mutate the DOM all the time; a route change is a URL change.                                                                                                      |
| Ending the run on every new document (Phase 6a)          | Breaks multi-page guides and reloads, which real flows need.                                                                                                                   |
| The worker pushing the step to the new document          | The new content script is not active until its `page.hello` is answered, so a pushed step could arrive first and be refused; pulling it with `player.resume` has no such race. |

## Consequences

- **Positive:** guides follow single-page routes, links, forms, reloads and back and forward. bfcache keeps working. No permission is added. A document that is gone or hidden in the cache can never drive the run.
- **Negative:** each new document of a guide costs one bearer request (the resume check). A run whose tab left the application stays in `storage.session` until the tab returns, closes or another guide starts there. Playwright disables bfcache by default, so its e2e scenario launches Chromium without that switch.
- **Limits:** frames and shadow roots stay Phase 6c. A same-origin iframe that navigates is not followed. Prerendered documents are not handled specially: their content script says hello only when they are shown.

## References

- Navigation API: https://developer.chrome.com/docs/web-platform/navigation-api
- bfcache and extension messaging: https://developer.chrome.com/blog/bfcache-extension-messaging-changes
- `pageshow` / `pagehide` and `persisted`: https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event
- `tabs.sendMessage` with `documentId`: https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage
- `:modal`: https://developer.mozilla.org/en-US/docs/Web/CSS/:modal
