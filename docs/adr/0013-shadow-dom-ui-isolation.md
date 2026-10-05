# ADR 0013: Shadow DOM isolation for injected UI

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

The content script draws UI inside applications ContextLayer does not control: a toast today, and later the element picker (Phase 5) and the guide player's highlight and popover (Phase 6). Those pages can break injected UI in many ways ([R-09](../technical-risks.md), [R-10](../technical-risks.md), [R-11](../technical-risks.md)):

- Global rules such as `div { display: none }`, inherited `font` and `color`, and a `rem` scale set by the page's root `font-size`.
- `z-index` wars, `overflow: hidden` containers and transformed ancestors that clip or trap fixed elements.
- Frameworks that replace `<body>` or remove unknown nodes.
- Strict CSP and Trusted Types.
- Hostile scripts that patch prototypes, predefine custom elements or read the DOM.

## Decision

**Implemented (Phase 1)** in `apps/extension/src/content/overlay.ts`:

| Measure                                                                         | Why                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host is a plain `<div data-contextlayer-root>`, not a custom element            | A page could define our custom tag first. Our `createElement` would then run the page's constructor, which can call `attachInternals()` and read even a closed root through `ElementInternals.shadowRoot`. Built-in elements cannot be redefined, and `customElements` is `null` in the isolated world anyway. |
| Created lazily, removed when the toast hides, re-created if the page removed it | Nothing sits in the DOM while idle. The host carries no version attribute that could fingerprint the extension.                                                                                                                                                                                                |
| Appended to `document.documentElement`                                          | Survives frameworks that replace `<body>` and avoids page effects applied to `body`.                                                                                                                                                                                                                           |
| `attachShadow({ mode: 'closed' })`                                              | `host.shadowRoot` returns `null` to page scripts.                                                                                                                                                                                                                                                              |
| `:host { all: initial !important }`                                             | For normal declarations, page rules that match the host beat `:host` (CSS Cascade 5). Only `!important` inside the shadow context wins.                                                                                                                                                                        |
| Constructable stylesheet (`replaceSync` + `adoptedStyleSheets`)                 | No `<style>` element and no network fetch. CSSOM sheets are not governed by the page's `style-src`.                                                                                                                                                                                                            |
| px units and a system font stack                                                | `rem` resolves against the page's root font size even inside a shadow tree, and `@font-face` declared in a shadow root does not apply.                                                                                                                                                                         |
| Toast is `popover="manual"` with `role="status"`                                | The top layer sits above any page `z-index` and escapes `overflow` and transforms. `manual` means no light dismiss.                                                                                                                                                                                            |
| Text set only with `textContent`                                                | Text never becomes markup. Event-handler attributes created by a content script would compile in the page's main world.                                                                                                                                                                                        |
| Listener registered before any DOM work; drawing failures caught                | A hostile page cannot stop the script from answering (`src/content/index.ts`).                                                                                                                                                                                                                                 |

Verified by the extension e2e suite (`apps/extension/e2e/extension.spec.ts`): the root is closed, the host's only attribute is `data-contextlayer-root`, the host disappears after the toast, and the UI still mounts on a fixture page that overrides `Element.prototype.attachShadow` and predefines `contextlayer-root`. The isolated world has its own prototypes, so the page's patch does not apply.

**What isolation does not provide.** A closed shadow root isolates styles and hides the tree from casual scripts. It is not a security boundary. UI events are composed and reach page listeners retargeted to the host, page capture listeners run first, and the page can remove, cover or imitate our UI. So:

- No secrets are ever rendered in the shadow root.
- **Planned (Phase 5):** text entry for guide authoring moves to the side panel, an extension page the host cannot observe.
- **Planned (Phase 6):** player controls check `event.isTrusted`.

**Styling the larger UI.** Phase 1 uses plain CSS. Tailwind v4 utilities that rely on `@property` (shadows, rings, transforms) compute to `none` inside a shadow root (measured in Chromium 153; tailwindcss#15005). **Planned (Phase 6):** evaluate a build-time transform that turns each `@property` initial value into a declaration on `:host, *, ::before, ::after, ::backdrop` and converts rem to px. The alternative, hoisting `@property` into the page, writes to the host page's global registry and can collide with its own Tailwind.

## Alternatives considered

| Option                                                     | Why not                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inject plain elements with prefixed classes                | Page CSS leaks in, and our CSS can leak out.                                                                                                                                                                                                                                       |
| Open shadow root                                           | Playwright locators and Floating UI pierce it easily, but so can any page script through `host.shadowRoot`.                                                                                                                                                                        |
| Custom-element host (`<contextlayer-ui>`, the WXT default) | Can be pre-registered by the page (see above).                                                                                                                                                                                                                                     |
| `<style>` element in the shadow root                       | It works, because the isolated world's CSP applies, but `adoptedStyleSheets` avoids the CSP question entirely.                                                                                                                                                                     |
| Extension page in an `<iframe>`                            | Strongest isolation (a separate origin), but it needs `web_accessible_resources` (detectable unless `use_dynamic_url`), message hops per interaction, and cross-frame positioning and focus for a card that tracks a moving target. The side panel covers sensitive input instead. |
| Render from a MAIN-world script                            | Subject to the page's CSP and Trusted Types, and the page can hook every API it uses.                                                                                                                                                                                              |
| Tailwind in the shadow root as compiled                    | `@property`-based utilities break silently.                                                                                                                                                                                                                                        |

## Consequences

### Positive

- The toast works on a normal and a hostile fixture page, with no permissions and no web-accessible resources. A strict-CSP fixture is Planned for Phase 5 (picker) and reused by the Phase 6 player.
- The pattern (host, closed root, adopted sheet, top-layer popover) scales to the picker and the player.

### Negative and trade-offs

- **Testing.** Playwright cannot pierce closed roots, so e2e tests assert effects (host attributes, message results, `shadowRoot === null`). **Proposed (Phase 6):** an open root in a test-only build if the player needs DOM assertions.
- **Leaks `all` does not stop:** custom properties, `direction` and `unicode-bidi`. The Phase 6 UI sets every variable it uses and `direction` on `:host`.
- **Host modals.** A page `showModal()` dialog makes everything outside it inert, including our popover. **Planned (Phase 6):** move the host into the modal and re-show the popover.
- No shared Tailwind tokens with the dashboard until the transform exists, and a page can still detect that ContextLayer is showing UI.

### Follow-ups

- **Planned (Phase 6):** accessibility of the player ([R-16](../technical-risks.md)): an `aria-live` region, a non-modal labelled card, no focus stealing and reduced motion.

## References

- `Element.attachShadow`: https://developer.mozilla.org/en-US/docs/Web/API/Element/attachShadow
- `ElementInternals.shadowRoot`: https://developer.mozilla.org/en-US/docs/Web/API/ElementInternals/shadowRoot
- CSS Cascade 5, shadow context: https://drafts.csswg.org/css-cascade-5/#cascade-context
- Popover API: https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using
- `@property` in shadow roots (WPT): https://wpt.fyi/results/css/css-properties-values-api/at-property-shadow.html?label=master&label=stable
- Tailwind CSS issue #15005: https://github.com/tailwindlabs/tailwindcss/issues/15005
- Content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
