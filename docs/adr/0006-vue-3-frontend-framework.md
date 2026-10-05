# ADR 0006: Vue 3 for the dashboard and extension UI

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

ContextLayer has three UI surfaces:

| Surface                                                              | Runs in                                                                                     | Phase                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Admin dashboard (single-page app)                                    | ContextLayer's own origin                                                                   | Implemented (Phase 1) as a status page; product screens from Phase 2 |
| Extension pages: popup today, side panel for the guide builder later | `chrome-extension://` pages                                                                 | Popup implemented (Phase 1); side panel Planned (Phase 5)            |
| In-page UI: toast today, guide player popover later                  | A closed shadow root inside third-party pages ([ADR 0013](0013-shadow-dom-ui-isolation.md)) | Toast implemented (Phase 1); player Planned (Phase 6)                |

ContextLayer controls the first two. The third is injected into every matched page of a customer's application, where bundle size and isolation outweigh ergonomics.

Constraints: strict TypeScript everywhere, a team of one, components shared between dashboard and extension, and the MV3 extension-page CSP. That CSP blocks `eval` and `new Function`, so templates cannot be compiled at runtime and must be precompiled at build time.

## Decision

**Implemented (Phase 1):**

- Vue 3.5 with the Composition API and `<script setup lang="ts">` for the dashboard (`apps/dashboard`) and the extension popup (`apps/extension/src/popup`). `@vitejs/plugin-vue` compiles single-file components (SFCs) at build time, so only Vue's runtime ships, which satisfies the MV3 CSP.
- Shared components and Tailwind v4 theme tokens live in `packages/ui` (`StatusBadge`, `theme.css`). Both Vite builds consume that package from source ([ADR 0011](0011-source-first-workspace-packages.md)).
- Templates are type-checked with `vue-tsc --build --force` (`--force` because workspace packages consumed from source are not tracked by the incremental build info). `@vue/eslint-config-typescript` (`withVueTs`) runs type-aware lint rules inside `.vue` files. Components are tested with `@vue/test-utils` on jsdom.
- State stays local to features: composables such as `useApiHealth` and `shallowRef`. There is no router and no global store yet.
- In-page UI stays framework-free for now. `apps/extension/src/content/overlay.ts` uses plain DOM APIs. Whether the Phase 6 player uses Vue is decided per feature against the content-script size budget (R-15 in [technical risks](../technical-risks.md)).

## Alternatives considered

| Option                                   | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React                                    | Technically just as valid, with a larger ecosystem. Vue was chosen because SFCs keep template, logic and styles in one file with little boilerplate, and because choosing it for both surfaces keeps the project on one framework. This is a preference, not a missing capability.                                                                                                                                                                 |
| Svelte                                   | Compiles to smaller bundles, which is attractive for in-page UI. Its ecosystem is smaller for dashboard needs (tables, forms, charts), and using it only in the content script would add a second framework.                                                                                                                                                                                                                                       |
| Lit or vanilla web components everywhere | Native encapsulation suits injected UI, but `customElements` is `null` in the content script's isolated world, so neither Lit nor custom elements can be defined there, and a page-predefined tag would reach a closed root ([ADR 0013](0013-shadow-dom-ui-isolation.md)). A dashboard with routing, forms and tables would also have to rebuild what a framework already provides. In-page UI uses plain DOM inside a closed shadow root instead. |
| One framework per surface                | Two component models and two test setups, and no shared `packages/ui`.                                                                                                                                                                                                                                                                                                                                                                             |

## Consequences

### Positive

- One component model, one lint and test toolchain, and one UI kit for the dashboard and the extension pages.
- Small runtime, and precompiled templates work under the MV3 CSP without any CSP exception.
- `vue-tsc` checks templates, so a prop or event mismatch fails `pnpm typecheck`.

### Negative and trade-offs

- **Size cost if Vue goes in-page.** Every matched page would load the Vue runtime. In the research spike, Vue plus one SFC plus zod came to 139.6 kB minified (46 kB gzip). Today's framework-free `content.js` is about 89 kB (26 kB gzip). Tailwind (preflight plus about 10 utilities) adds roughly 21 kB more, and its `@property`-based utilities (shadow, ring, transforms) compute to `none` inside a shadow root.
- **No `vue()` in the content build yet.** Importing a `.vue` file or `@contextlayer/ui` there fails until the plugin is added ([ADR 0009](0009-extension-build-tooling.md)).

### Follow-ups

- **Planned (Phase 2):** `vue-router` and authentication screens in the dashboard. **Proposed:** add a global store such as Pinia only when feature composables are no longer enough.
- **Planned (Phase 5):** the guide builder as a Vue side-panel page that reuses `packages/ui`.
- **Planned (Phase 6):** choose Vue or vanilla DOM for the player against a measured size budget. If Vue wins, add `vue()` to the content build (and `tailwindcss()` once a shadow-safe CSS pipeline exists).

## References

- Vue tooling, runtime-only build with precompiled templates: https://vuejs.org/guide/scaling-up/tooling.html
- MV3 extension-page CSP: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- Tailwind `@property` in shadow roots: https://github.com/tailwindlabs/tailwindcss/issues/15005
