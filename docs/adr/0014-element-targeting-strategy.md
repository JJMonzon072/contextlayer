# ADR 0014: Multi-signal target descriptors for element targeting

- Status: Proposed
- Date: 2026-10-04
- Deciders: JJ

## Context

Each guide step points at an element in an app ContextLayer does not control, and that app changes after capture ([R-04](../technical-risks.md) to [R-08](../technical-risks.md)): ids are generated (React `useId` gives `:r1:`, `«r1»` or `_r_1_` by version; Vue 3.5 gives `v-1`), classes are hashed (CSS Modules, Emotion, styled-components), nodes are re-rendered, lists virtualized, text localized, and targets sit in shadow roots and iframes. **Highlighting the wrong element is worse than finding none**; Appcues, for example, refuses to show a step whose selector is not unique.

Prior art: Playwright's selector generator scores a test id 1, role plus name 100, label 140, text 180, `#id` 500 (skipped if generated-looking), `nth` 10 000 and a CSS fallback 10 000 000. Testing Library queries by role first. Similo scores candidates by weighted similarity over many attributes and roughly halved locator failures (72 versus 146 of 598). A content script cannot read the accessibility tree, so accessible names are computed in JavaScript.

## Decision

**Proposed.** Store a versioned, multi-signal `TargetDescriptor` per step and resolve it by scoring. Never guess silently.

### What is stored where

| Data                    | Location                                                                                                                                                                                                                  | Phase                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `TargetDescriptor` v1   | `guide_steps.target jsonb`, validated by a zod union on `version` in `packages/shared`. Unknown versions are rejected and strings capped.                                                                                 | Planned (Phase 3 contract, Phase 5 capture) |
| Frozen copy for players | `guide_versions.snapshot`                                                                                                                                                                                                 | Planned (Phase 3)                           |
| Page matching           | URLPattern init objects (descriptor `page.urlPattern`, optionally overridden by `guide_steps.url_pattern`), evaluated in the extension. Node 22 has no URLPattern, so the API narrows by origin (`applications.origins`). | Planned (Phase 6)                           |
| Resolution outcome      | `guide_events` of type `target_not_found`, with `metadata.reason` and per-strategy counts. Page text is never stored.                                                                                                     | Planned (Phase 7)                           |

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

### Capture heuristics (Planned, Phase 5)

1. **Pick the real element.** A capture-phase listener on `window` calls `preventDefault()` and `stopImmediatePropagation()` for pointer, mouse and click events, so the click neither triggers its default action nor reaches the page's own handlers. Page listeners registered earlier on `window` in the capture phase still run first; a transparent top-layer picker overlay that receives the click avoids triggering page elements at all. The picker descends through shadow hosts with `chrome.dom.openOrClosedShadowRoot` and `elementFromPoint`.
2. **Promote** the picked node to its interactive ancestor (`button`, `a`, `[role=button|link|checkbox|tab|menuitem]`).
3. **Test attributes** in order: first-party `data-contextlayer-id`, then `data-testid`, `data-test`, `data-qa`, `data-cy`.
4. **Filter generated values at every stage, including the CSS path.** Ids: `useId` patterns, UUIDs, runs of 4+ digits, and Playwright's `isGuidLike`. Classes: hashed CSS-in-JS and CSS Modules names, Tailwind utilities and state classes.
5. **Compute role and accessible name** in JavaScript. Record `matchCount` per locator at capture time.
6. **Warn about weak targets.** Show "weak target" when no unique test id, stable id or role plus name exists.
7. **Privacy.** Cap strings at 80 characters, redact emails and long digit runs, and store URLs as patterns (`:projectId`). XPath is emitted for light-DOM targets only.

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
- **Follow-ups:** accept the storage shape in Phase 3, capture in Phase 5, resolution in Phase 6 ([roadmap](../roadmap.md)), with a fixture corpus (generated ids, CSS-in-JS, shadow roots, iframes, virtualized lists, modals).

## References

- Playwright locators: https://playwright.dev/docs/locators
- Testing Library query priority: https://testing-library.com/docs/queries/about/#priority
- Chrome DevTools Recorder selectors: https://developer.chrome.com/docs/devtools/recorder/reference
- Similo (weighted multi-locator): https://arxiv.org/abs/2208.00677
- `chrome.dom.openOrClosedShadowRoot`: https://developer.chrome.com/docs/extensions/reference/api/dom
- `checkVisibility()`: https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility
- URLPattern: https://developer.mozilla.org/en-US/docs/Web/API/URLPattern
