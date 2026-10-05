# ADR 0014: Multi-signal target descriptors for element targeting

- Status: Accepted for the stored shape (TargetDescriptor v1, Phase 3) and for capture (implemented in Phase 5); Proposed for resolution (Phase 6)
- Date: 2026-10-04
- Deciders: JJ

## Context

Each guide step points at an element in an app ContextLayer does not control, and that app changes after capture ([R-04](../technical-risks.md) to [R-08](../technical-risks.md)): ids are generated (React `useId` gives `:r1:`, `«r1»` or `_r_1_` by version; Vue 3.5 gives `v-1`), classes are hashed (CSS Modules, Emotion, styled-components), nodes are re-rendered, lists virtualized, text localized, and targets sit in shadow roots and iframes. **Highlighting the wrong element is worse than finding none**; Appcues, for example, refuses to show a step whose selector is not unique.

Prior art: Playwright's selector generator scores a test id 1, role plus name 100, label 140, text 180, `#id` 500 (skipped if generated-looking), `nth` 10 000 and a CSS fallback 10 000 000. Testing Library queries by role first. Similo scores candidates by weighted similarity over many attributes and roughly halved locator failures (72 versus 146 of 598). A content script cannot read the accessibility tree, so accessible names are computed in JavaScript.

## Decision

Store a versioned, multi-signal `TargetDescriptor` per step and resolve it by scoring. Never guess silently. The storage half is **Accepted and implemented** (Phase 3) and capture is **Accepted and implemented** (Phase 5, below); resolution stays **Proposed** until it is built against a fixture corpus.

### What is stored where

| Data                    | Location                                                                                                                                                                                                                                                   | Phase                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `TargetDescriptor` v1   | `guide_steps.target jsonb`, validated by a zod union on `version` in `packages/shared/src/target-descriptor.ts`. Unknown versions and unknown keys are rejected, strings and arrays capped, the whole descriptor ≤ 16 384 characters. Null until captured. | Implemented (Phase 3 contract, Phase 5 capture) |
| Frozen copy for players | `guide_versions.snapshot` ([ADR 0016](0016-immutable-published-guide-versions.md))                                                                                                                                                                         | Implemented (Phase 3)                           |
| Page matching           | URLPattern init objects (descriptor `page.urlPattern`, optionally overridden by `guide_steps.url_pattern`), evaluated in the extension. Node 22 has no URLPattern, so the API narrows by origin (`applications.origins`).                                  | Planned (Phase 6)                               |
| Resolution outcome      | `guide_events` of type `target_not_found`, with `metadata.reason` and per-strategy counts. Page text is never stored.                                                                                                                                      | Planned (Phase 7)                               |

### Example (light-DOM target in a modal)

```json
{
  "version": 1,
  "capturedAt": "2026-10-04T15:21:07Z",
  "capture": {
    "extensionVersion": "0.1.0",
    "viewport": { "width": 1440, "height": 900, "devicePixelRatio": 2 },
    "pickedTag": "span",
    "promotion": "interactive-ancestor"
  },
  "page": {
    "urlPattern": {
      "protocol": "https",
      "hostname": "app.acme.test",
      "pathname": "/projects/:projectId/settings"
    }
  },
  "framePath": [],
  "shadowPath": [],
  "container": {
    "kind": "dialog",
    "role": "dialog",
    "accessibleName": "Billing details",
    "modal": true
  },
  "element": {
    "tag": "button",
    "role": "button",
    "accessibleName": "Save changes",
    "text": "Save changes",
    "testIds": [{ "attr": "data-testid", "value": "billing-save" }],
    "id": { "value": "save-7f3a9c21", "generated": true },
    "attributes": { "type": "submit", "title": null, "placeholder": null },
    "classes": { "stable": ["btn", "btn-primary"], "droppedCount": 4 },
    "nthOfType": { "index": 2, "count": 2 },
    "rect": { "x": 1180, "y": 640, "width": 120, "height": 36 }
  },
  "anchors": [
    { "relation": "ancestor", "distance": 2, "tag": "form", "id": "billing-form" },
    { "relation": "precedingHeading", "level": 2, "text": "Payment method" }
  ],
  "locators": [
    {
      "strategy": "testId",
      "attr": "data-testid",
      "value": "billing-save",
      "scope": "root",
      "matchCount": 1
    },
    {
      "strategy": "role",
      "role": "button",
      "name": "Save changes",
      "exact": true,
      "scope": "container",
      "matchCount": 1
    },
    {
      "strategy": "cssPath",
      "selector": "form#billing-form > div:nth-of-type(4) > button:nth-of-type(2)",
      "scope": "root",
      "matchCount": 1
    },
    {
      "strategy": "xpath",
      "expression": "//form[@id='billing-form']/div[4]/button[2]",
      "scope": "root",
      "matchCount": 1
    }
  ],
  "resolution": {
    "minScore": 0.65,
    "minMargin": 0.15,
    "timeoutMs": 10000,
    "textPolicy": "normalized",
    "onAmbiguous": "show-unanchored",
    "onNotFound": "show-unanchored"
  }
}
```

`framePath` hops hold an iframe's URL pattern, name, title, test id and index. `shadowPath` hops hold the root's mode and the host's tag, test id, id and CSS path. CSS locators are relative to the innermost root.

### Capture (Implemented, Phase 5)

Code: `apps/extension/src/content/capture/` (descriptor) and `src/content/picker.ts` (selection), run in the content script's isolated world for the top document's light DOM; the side panel and the worker are in [ADR 0018](0018-side-panel-edit-mode.md).

1. **Pick the real element.** While Edit Mode is selecting, listeners on `window` in the capture phase call `preventDefault()` and `stopImmediatePropagation()` on pointer, mouse, touch, click, submit and key events, so the click neither runs its default action (link, submit, focus) nor reaches the page's handlers. Limit: page listeners registered earlier on `window` in the capture phase still run first. Hover is resolved once per animation frame with `document.elementsFromPoint`, skipping ContextLayer's own host (its UI also has `pointer-events: none`). Events the page dispatches itself (`isTrusted === false`) never select or cancel. Escape or the 2-minute limit cancel; Tab and Enter select from the keyboard. Elements in iframes, behind shadow hosts (open or closed, detected with `chrome.dom.openOrClosedShadowRoot`), `body` and `html` are refused with a reason, never replaced by another element: `framePath` and `shadowPath` are always `[]` in Phase 5 (6c).
2. **Promote** the picked node to its interactive ancestor (`button`, `a[href]`, `summary`, form controls, `[role=button|link|checkbox|radio|switch|tab|menuitem…|option|treeitem]`) within 6 levels, never up to `body`. Inside an SVG graphic the picked node is the outermost `<svg>`. `capture.pickedTag` and `capture.promotion` record what happened.
3. **Test attributes** in order: `data-contextlayer-id`, `data-testid`, `data-test`, `data-qa`, `data-cy`; values that look like counters or row ids are not used.
4. **Filter generated values at every stage, including the CSS path.** Ids: React `useId` (`:r1:`, `«r1»`, `_r_1_`), Vue `v-1`, UUIDs, runs of 4+ digits, trailing counters, framework prefixes, hash-like suffixes and Playwright's `isGuidLike`. A generated id is kept only as `element.id` with `generated: true` (a hint, never a locator or path step); an id that looks like a record id (UUID, 4+ digits) is not stored at all. Classes: CSS-in-JS and CSS Modules hashes, state and Tailwind-style utility classes. These are heuristics: a random suffix made only of letters (`export-qkzbfa`) cannot be told from a word, and is kept.
5. **Role and accessible name** come from an own, bounded subset of WAI-ARIA role mapping and accname 1.2 (`capture/accessible.ts`, documented as such): explicit roles, implicit roles of common elements, `aria-labelledby`, `aria-label`, `<label>`, `alt`, name from content and `title`/`placeholder`. Unlike accname, a hidden element referenced by `aria-labelledby` contributes nothing.
6. **`matchCount`** is counted over the whole document with the same definition the value was captured with: `querySelectorAll` of the exact attribute or selector for `testId`, `id`, `placeholder`, `altText`, `title`, `css` and `cssPath`; elements with that role and exactly that name for `role`; form controls whose labels read exactly that text for `label`; the deepest elements whose visible text is exactly that text for `text` (the span inside a button: the resolver is expected to promote it the same way). A locator that cannot be counted (more than 5 000 candidates) is left out, never assumed unique; a locator that matches nothing is dropped.
7. **CSS path.** Tags and `:nth-of-type` from the nearest ancestor with a stable unique id or `data-testid`, or from `body`; at most 24 levels and 512 characters, otherwise no path (never a cut one). **XPath is not emitted**: in the light DOM it would repeat the CSS path. The schema still accepts it.
8. **Privacy.** Two separate policies apply.
   - **Exclusion of what users type (guaranteed for these sources).** Form controls (`input`, `textarea`, `select`) and editable content are never read, by any path that builds the descriptor: the target's name and text, the heading before it, labels, `aria-labelledby` references, container names and the text counted for locators. The check runs at the root of every text extraction and at every node below it. Editable means an editing host above or at the node (`contenteditable` true, empty or `plaintext-only`, also through `false` islands and `inherit`) or a document in design mode. Inside an editable region, nodes other than the host are not read at all (no name, text, attributes, ids, test ids, classes or path anchors); only their counted position describes them. Values are excluded before reading, never read and then cleaned. Limit: text a page renders itself from user input outside form controls and editable regions (a customer's name shown as plain text, an editor that draws without `contenteditable`) cannot be told from the page's own text and only goes through redaction.
   - **Redaction of allowed text (heuristic).** Every stored string is whitespace-normalized, capped at 80 characters (with `…`) and has emails and runs of 5+ digits (phones, cards, ids) replaced by `[email]` and `[number]`. A value that was redacted or cut no longer equals the page, so it is never used as a locator. The page is stored as a pattern of scheme, host, port and path, with numeric, id-like, email-like and long segments replaced by `:id` (`/customers/48213/edit` → `/customers/:id/edit`); query, fragment and credentials are never kept. Names of people in visible text cannot be detected: the side panel lists every stored value ("What will be saved") so the author can review the target, select another one or remove it before saving. Descriptors are never logged.
9. **Weak targets.** The panel derives a category from the stored descriptor (`src/authoring/target-summary.ts`): stable (a unique test attribute or stable id), found by name (a unique role and name, label, text…) or weak, with the reasons ("Only structural selectors are available", "Several elements share this label", "Dynamic identifiers were ignored", "Some text was hidden for privacy"). These are categories, not probabilities; nothing claims a confidence percentage.
10. **`resolution`** holds the starting values above (`minScore` 0.65, `minMargin` 0.15, 10 s, `show-unanchored`) because the schema requires them; they are not calibrated until Phase 6.

Work is bounded: hover does one hit test and one promotion per frame; the full descriptor is built only for the selected element; counts stop above 5 000 candidates; a descriptor over 16 384 characters drops its anchors, then refuses. The whole content script stays under its build-enforced budget (`apps/extension/scripts/budget.ts`).

### Resolution (Planned, Phase 6)

1. If `page.urlPattern` does not match `location.href`, the outcome is `wrong-page`.
2. Resolve the roots: frame, then shadow hosts (`shadowRoot` or `chrome.dom.openOrClosedShadowRoot`), then the container.
3. Generate candidates from cheap to expensive: test id, stable id, role plus name, label/placeholder/alt/title, text, CSS, CSS path, XPath. Keep at most about 50 per root.
4. Drop candidates that are disconnected, inside `[inert]`, fail `checkVisibility()` or have an empty box.
5. Score each candidate as `Σ wᵢ·simᵢ / Σ wᵢ` over the signals the descriptor has. Starting weights: test id 1.0, id 0.8, role + name 0.8, label 0.7, text 0.6, attributes and anchors 0.5, container 0.4, CSS path 0.3, classes 0.25, XPath 0.2, nth and rect 0.1.
6. **Veto** contradictions: the same test attribute with a different value, or a different role, scores 0.
7. **Accept** a unique test-id match, or a best score ≥ `minScore` with a lead of ≥ `minMargin` over the runner-up. A best score above the threshold without that lead is `ambiguous`.
8. **Check stability.** The box must stay the same for two animation frames. Occlusion found with `elementsFromPoint` only warns.
9. **Wait** if nothing is accepted: one `MutationObserver` per root (a document observer does not see shadow trees), at most one retry per ~150 ms, an `AbortController` per step, `not-found` at `timeoutMs` (10 s). Re-run on Navigation API `currententrychange`; re-resolve with a 1–2 s grace period if the target disconnects mid-step.

| Outcome                           | Player behaviour                                | Recorded                                |
| --------------------------------- | ----------------------------------------------- | --------------------------------------- |
| `resolved` (confidence)           | Highlight and popover                           | `step_viewed`                           |
| `ambiguous` (top-3 scores)        | Step per `onAmbiguous`: unanchored, skip or end | `target_not_found`, reason `ambiguous`  |
| `not-found` (counts per strategy) | Step per `onNotFound`                           | `target_not_found`, reason `not-found`  |
| `wrong-page`                      | Waits for navigation; can show a hint           | `target_not_found`, reason `wrong-page` |

The thresholds are starting values, to be calibrated against a fixture corpus in Phase 6.

## Alternatives considered

| Option                                                  | Why not                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| One CSS selector                                        | Breaks on generated ids, hashed classes and structural edits, and cannot tell "unique" from "first match".                |
| Ordered fallback list (first locator that matches wins) | A stale high-priority locator that now matches another element yields a confident wrong target, with no ambiguity signal. |
| Absolute XPath                                          | Breaks on any structural change and cannot cross shadow roots.                                                            |
| Require customers to add `data-*` attributes            | The best signal, but it contradicts "no source changes". It is supported as an optional first-party attribute.            |
| Visual or ML matching, automatic healing                | MVP non-goals: heavy, opaque, and stored targets would drift silently.                                                    |

## Consequences

- **Positive:** survives the loss of individual signals, and failures are explainable through scores and per-strategy counts. The version field allows schema evolution.
- **Negative:** a few KB of JSON per step; complex capture; accessible-name computation and scoring add content-script weight ([R-15](../technical-risks.md)) and CPU on large DOMs (bounded by the candidate cap); captured text may contain personal data; thresholds need tuning.
- **Follow-ups:** storage shape accepted and implemented in Phase 3. Its limits, in `packages/shared/src/target-descriptor.ts`:
  - captured strings ≤ 80 characters, selectors ≤ 512;
  - 1–12 locators of 11 known strategies;
  - ≤ 6 anchors, ≤ 5 frame and ≤ 5 shadow hops, ≤ 12 attributes;
  - strict objects everywhere.

  A step's `target` is null until captured, which also allows unanchored steps. Capture is implemented (Phase 5) and covered by unit tests and a demo page; resolution (Phase 6, [roadmap](../roadmap.md)) is still to be validated with a fixture corpus (generated ids, CSS-in-JS, shadow roots, iframes, virtualized lists, modals), which will also tell whether the capture heuristics above need a v2.

## References

- Playwright locators: https://playwright.dev/docs/locators
- Testing Library query priority: https://testing-library.com/docs/queries/about/#priority
- Chrome DevTools Recorder selectors: https://developer.chrome.com/docs/devtools/recorder/reference
- Similo (weighted multi-locator): https://arxiv.org/abs/2208.00677
- `chrome.dom.openOrClosedShadowRoot`: https://developer.chrome.com/docs/extensions/reference/api/dom
- `checkVisibility()`: https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility
- URLPattern: https://developer.mozilla.org/en-US/docs/Web/API/URLPattern
