# ADR 0011: Source-first workspace packages via a custom export condition

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

`@contextlayer/shared` holds the zod contracts every app uses ([ADR 0010](0010-runtime-validated-shared-contracts.md)). Several tools resolve it, and each needs it in a different form:

| Consumer                                  | Needs                                           |
| ----------------------------------------- | ----------------------------------------------- |
| `tsc`, `vue-tsc`, typed ESLint            | Types, ideally from source for go-to-definition |
| Vite (dashboard; both extension builds)   | ESM it can transform                            |
| Vitest (Node and jsdom projects)          | Same as Vite, without a prior build             |
| API dev server (`tsx watch`)              | TypeScript, restarted on change                 |
| API in production (`node dist/server.js`) | Plain JavaScript; no TypeScript at runtime      |

If the package resolved only to its compiled `dist`, every test run, type-check and dev server would wait for a build, and watch mode would race: the API restarts while `dist` is half written. If it resolved only to `src`, the production API would need a TypeScript runtime. `tsc` does not emit files it resolves from another package; it treats them as external libraries.

## Decision

**Implemented (Phase 1).** `packages/shared/package.json` publishes both forms behind a custom export condition:

```json
"exports": {
  ".": {
    "@contextlayer/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

Resolvers pick the first key whose condition they have enabled, so the custom condition comes first. Tools that enable it read `src`. Anything else, including plain Node, falls through to `dist`.

| Where the condition is enabled                      | Setting                                                                        | File                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| TypeScript (every preset)                           | `customConditions: ["@contextlayer/source"]`                                   | `packages/config/tsconfig/base.json`                                 |
| Vite: dashboard, extension pages and content script | `resolve.conditions: ['@contextlayer/source', ...defaultClientConditions]`     | `apps/dashboard/vite.config.ts`, `apps/extension/vite.config.ts`     |
| Vitest jsdom projects                               | Same `resolve.conditions`                                                      | `apps/dashboard/vitest.config.ts`, `apps/extension/vitest.config.ts` |
| Vitest Node project                                 | `ssr.resolve.conditions: ['@contextlayer/source', ...defaultServerConditions]` | `apps/api/vitest.config.ts`                                          |
| API dev server                                      | `tsx watch --conditions=@contextlayer/source`                                  | `apps/api/package.json`                                              |
| **Disabled:** API production build                  | `customConditions: []`, so types come from `dist/index.d.ts`                   | `apps/api/tsconfig.build.json`                                       |

Supporting rules:

- **Build order.** `pnpm build` runs `pnpm --recursive run build` in topological order, so `packages/shared` emits `dist` before `apps/api` compiles against it. `pnpm start` then runs `node dist/server.js`, which loads `packages/shared/dist/index.js`.
- **Spread Vite's defaults.** Setting `resolve.conditions` or `ssr.resolve.conditions` replaces Vite's defaults instead of adding to them. Node test files resolve through the SSR resolver, so the API project needs `ssr.resolve.conditions`. Commit `3054aff` includes the fix for an API config that only worked by accident.
- **One import style for two resolution modes.** `tsc` type-checks the shared source under each consumer's options: NodeNext for the API, Bundler for Vite apps. Shared therefore uses explicit `.js` relative specifiers (`./health.js`), which both modes accept.
- **`packages/ui` is source-only.** Its exports point at `./src/index.ts` and `./src/styles/theme.css`, with no build. Only Vite consumes it (dashboard, popup), and `.vue` files need the Vue plugin anyway. `theme.css` contains `@source '..'` so consumers' Tailwind scans the kit's classes.
- **Full type-checks.** Dashboard and extension run `vue-tsc --build --force`. Incremental `--build` trusts its build info, which does not track workspace sources consumed through the condition, so a breaking change in `packages/shared` was reported as up to date (fixed in commit `ee8a7f5`).

## Alternatives considered

| Option                                                                                             | Why not                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always consume `dist` (`tsc --watch` in shared during dev)                                         | Cold start needs a build, tests depend on build state, and watchers race.                                                                                                                                                                 |
| TypeScript `paths` aliases to `packages/shared/src`                                                | Only `tsc` reads them. Vite, Vitest and tsx each need a matching alias, and `tsc` does not rewrite them in emitted JavaScript, so `dist/server.js` would import a specifier Node cannot resolve. The alias leaks into runtime resolution. |
| Project references only (`tsc -b`)                                                                 | Orders builds and type-checks for `tsc`, but Vite, Vitest and tsx resolve through `exports`, so they still need `dist` or aliases.                                                                                                        |
| Source-only shared, run TypeScript in production (tsx, or Node type stripping with `--conditions`) | Ships a TypeScript runtime to production. Node's type stripping ignores tsconfig and does not map `./health.js` to `health.ts`, so it fails on the shared sources.                                                                        |
| Bundle the API (esbuild or Rolldown) and inline shared                                             | Valid, but it adds a bundler, source-map setup and a second build model for one package. Revisit in Phase 8 if image size or startup time matters.                                                                                        |

## Consequences

### Positive

- No build before `pnpm dev`, `pnpm test`, `pnpm typecheck` or `pnpm lint`. A change in `packages/shared` reaches the dashboard through Vite and restarts the API through `tsx watch`.
- Editors jump to the real source, not to `.d.ts` files.
- Production runs compiled JavaScript only, and its resolution path is the one Node uses by default.

### Negative and trade-offs

- **Two resolution paths.** Development reads `src` and production reads `dist`, so a missing or stale build can pass in development and fail in production. Mitigation: `pnpm test:e2e` builds first and starts the API with `node dist/server.js` (`apps/dashboard/playwright.config.ts`, `apps/extension/playwright.config.ts`). On CI the built API is always started; locally an API already listening on :3000 (for example `pnpm dev`) is reused, so stop `pnpm dev` to exercise the `dist` path.
- **Seven configuration sites** (the TypeScript base preset, two Vite configs, three Vitest configs and the API dev script), plus the override in `apps/api/tsconfig.build.json`. Each names the condition, and the five Vite and Vitest configs must also spread Vite's defaults. A missing condition usually fails loudly as an unresolved import, but not always (commit `3054aff`).
- **No incremental type-check** in the Vue apps because of `--force`. It costs seconds at the current size.
- Shared source must stay valid under both NodeNext and Bundler resolution.

### Follow-ups

- **Planned (Phase 2):** the CI pipeline runs `pnpm build` before the e2e suites, as `pnpm test:e2e` already does locally.
- **Proposed:** a small check that every Vite and Vitest config includes the condition, if more packages adopt it.
- **Planned (Phase 8):** reconsider bundling the API when the production image is built.

## References

- Node.js conditional exports: https://nodejs.org/api/packages.html#conditional-exports
- TypeScript `customConditions`: https://www.typescriptlang.org/tsconfig/#customConditions
- Vite `resolve.conditions`: https://vite.dev/config/shared-options
- Vitest common errors (resolution in Node vs jsdom projects): https://vitest.dev/guide/common-errors
- Node 22 `--conditions`: https://nodejs.org/docs/latest-v22.x/api/cli.html
