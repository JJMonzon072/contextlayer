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

Verified by the extension e2e suite (`apps/extension/e2e/site.spec.ts`, on an enabled customer site since Phase 4): the root is closed, the host's only attribute is `data-contextlayer-root`, the host disappears after the toast, and the UI still mounts on a fixture page that overrides `Element.prototype.attachShadow` and predefines `contextlayer-root`. The isolated world has its own prototypes, so the page's patch does not apply.

**Implemented (Phase 5): the Edit Mode picker and preview** use the same host and root. The overlay adds a highlight box, a short label (tag and role only, never page text), a banner ("Click an element to select it…") and a preview callout with the step's title, its instructions as lines of text and a **Close preview** button, each a `popover="manual"` element in the top layer:

- Everything drawn has `pointer-events: none` (the callout's button area excepted) and the picker's hit test skips the host, so the element under the pointer is always the page's.
- Positions are set through the CSSOM (`element.style.left`), which a CSP without `'unsafe-inline'` allows; no `style` attribute and no `<style>` element.
- The host exists only while something is shown and is removed when the picker stops, the preview closes, the session ends or the page loses access.
- Verified in Chromium 153 (`apps/extension/e2e/edit-mode.spec.ts`) on a demo page served with `default-src 'none'; script-src 'self'; style-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'`: the box is drawn with its 2 px border from the adopted sheet and the page records no `securitypolicyviolation` (a deliberate inline `<style>` added afterwards is recorded, as a control). The closed root is inspected only through CDP, which page scripts cannot use.

**What isolation does not provide.** A closed shadow root isolates styles and hides the tree from casual scripts. It is not a security boundary. UI events are composed and reach page listeners retargeted to the host, page capture listeners run first, and the page can remove, cover or imitate our UI. So:

- No secrets are ever rendered in the shadow root.
- **Implemented (Phase 5):** text entry for guide authoring lives in the side panel, an extension page the host cannot observe ([ADR 0018](0018-side-panel-edit-mode.md)); the page only gets the highlight and a text-only preview.
- **Implemented (Phase 5):** the picker ignores events with `isTrusted === false`, and blocks pointer, click, submit and key events from the page while selecting.
- **Implemented (Phase 6a):** the player card's buttons and Escape check `event.isTrusted`, and the card stops its clicks and keys from reaching page listeners in the bubble phase (a page menu that closes on an outside click stays open). Capture-phase page listeners still see them.

**Implemented (Phase 6a): the Guide Player** uses the same host and root. It adds a card (`role="dialog"`, a top-layer `popover="manual"`, the only part besides the preview callout that takes pointer events) next to the highlight box:

- The card holds the guide's title, "Step n of m", the step title, its instructions as lines of text, a hint when the target cannot be shown, Previous, Next or Finish, Close (×) and a polite live region. Everything is set with `textContent`; the step body arrives from the worker already turned into lines of plain text.
- **Placement without Floating UI.** The card needs two behaviours: flip (the step's placement, then the opposite side, then the others) and shift (slid along that side to stay in the viewport). They are a small pure module (`src/content/player/position.ts`) with its own tests, instead of a positioning library shipped to every page of every enabled site ([R-15](../technical-risks.md)). The card is positioned through the CSSOM, re-measured on scroll and resize once per frame; an unanchored card goes to the bottom-right corner.
- Accessibility ([R-16](../technical-risks.md)): the card is labelled by the step title and described by its instructions, both inside the same root (ARIA references cannot cross it); it takes the focus only when nothing on the page has it, never traps it, and Escape closes the guide only from inside the card. No animation; scrolling to an off-screen target is instant under `prefers-reduced-motion`.
- Verified in Chromium 153 (`apps/extension/e2e/player.spec.ts`), including on the strict-CSP demo page with 0 violations and the same inline-style control.

**Implemented (Phase 6b): pages that change** ([ADR 0019](0019-spa-navigation-and-player-resume.md)):

- **Host modals.** While the page has a modal `<dialog>` open (`dialog:modal`), the host moves into it: modality makes everything outside the dialog inert, our popovers included, and the dialog's own top-layer entry covers them. Moved, the popovers close, so the player shows them again; the card is then on top and takes pointer events and the focus. When the dialog closes, the host moves back to `documentElement`. The closed root, the adopted sheet and `:host { all: initial !important }` travel with the host; the dialog's styles do not reach inside.
- **A keyboard shortcut into the card.** `chrome.commands` `focus-guide`, suggested as Alt+Shift+G on Windows, Linux and ChromeOS and Control+Shift+G (`MacCtrl`) on macOS. The worker sends `player.focus` to the document showing the tab's guide; nothing happens on a tab without one. Why this key:
  - Chrome requires Ctrl or Alt in a command and forbids Ctrl+Alt (AltGr); `commands` is a manifest key, not a permission, with no install warning, and users can change or remove the key in `chrome://extensions/shortcuts`.
  - Chrome's documented shortcuts use neither Alt+Shift+G nor Control+Shift+G on macOS (its Alt+Shift ones are I and A; Cmd+Shift+G is Find previous on macOS). A modifier with Shift is not typed text, so it does not take a key from a field; Option on macOS types characters (Option+G is ©), hence `MacCtrl`. VoiceOver's keys are Control+Option.
  - Not a `keydown` listener in the page: the application sees keys first and can stop them, and it would take a key the application may use, with no way for the user to change it.
  - Limits: an operating-system or browser shortcut always wins over an extension's, and Chrome does not assign a suggested key that another extension already holds; the user then sets one in `chrome://extensions/shortcuts`. CDP input cannot press a browser shortcut, so e2e checks the command's path (`player.focus`) and the key itself is a manual check.
- **Focus restore.** When the card takes the focus (the shortcut, or the page had none), it remembers the element that had it, if any; Close, Escape and Finish give it back, with `preventScroll`, if that element is still connected, and only while the focus is still in the card. An element that left the page is not replaced by another one; a guide that ends on its own (Disconnect, revocation, another tab's Edit Mode) moves no focus; a new document starts with nothing to restore.
- **Waiting states.** While a step waits for its target or for the user to reach its page, the card shows a polite hint ("Looking for this step's element…", "This step is on another page. Navigate there to continue.") and no highlight.

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

- The toast, the picker and the preview work on a normal, a hostile and a strict-CSP fixture page, with no web-accessible resources. The strict-CSP demo page is reused by the Phase 6 player.
- The pattern (host, closed root, adopted sheet, top-layer popover) scales to the picker and the player.

### Negative and trade-offs

- **Testing.** Playwright cannot pierce closed roots, so e2e tests assert effects (host attributes, message results, `shadowRoot === null`) and read the UI through CDP, which page scripts cannot use (`DOM.getDocument` with `pierce`, computed styles, box models, the accessibility tree). **Decided (Phase 6a):** no open-root test build, so the build under test is the shipped one: the player's buttons are clicked with the real mouse at their CDP box, its focus is read from the isolated world (`chrome.dom.openOrClosedShadowRoot`), and axe audits a copy of the card's markup with the live adopted styles, since axe cannot enter a closed root.
- **Leaks `all` does not stop:** custom properties, `direction` and `unicode-bidi`. Implemented (Phase 6a): `direction: ltr !important` on `:host`; the player uses no custom properties.
- **Host modals.** A page `showModal()` dialog makes everything outside it inert, including our popover. **Implemented (Phase 6b):** the host moves into the open modal dialog and shows the popovers again, then moves back when the dialog closes. Limit: only `<dialog>` modals are detected; an overlay made modal with `aria-modal` and `inert` is not, though inert candidates are already left out by the visibility filter ([ADR 0014](0014-element-targeting-strategy.md)).
- No shared Tailwind tokens with the dashboard until the transform exists, and a page can still detect that ContextLayer is showing UI.

### Follow-ups

- **Implemented (Phase 6a):** accessibility of the player ([R-16](../technical-risks.md)): an `aria-live` region, a non-modal labelled card, no focus stealing and reduced motion. **Implemented (Phase 6b):** a keyboard shortcut into the card (`focus-guide`) and focus restore on Close, Escape and Finish. axe still audits a copy of the card out of the closed root, now also in the waiting, on-another-page, inside-a-modal and resumed states. Not automated: a screen reader (VoiceOver) and the shortcut key itself.

## References

- `Element.attachShadow`: https://developer.mozilla.org/en-US/docs/Web/API/Element/attachShadow
- `ElementInternals.shadowRoot`: https://developer.mozilla.org/en-US/docs/Web/API/ElementInternals/shadowRoot
- CSS Cascade 5, shadow context: https://drafts.csswg.org/css-cascade-5/#cascade-context
- Popover API: https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using
- `@property` in shadow roots (WPT): https://wpt.fyi/results/css/css-properties-values-api/at-property-shadow.html?label=master&label=stable
- Tailwind CSS issue #15005: https://github.com/tailwindlabs/tailwindcss/issues/15005
- Content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
