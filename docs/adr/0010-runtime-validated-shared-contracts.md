# ADR 0010: Runtime-validated shared contracts with zod

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

TypeScript types are erased at runtime, yet ContextLayer data crosses these boundaries:

| Boundary                                        | Risk                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| HTTP request into the API                       | Any client can send anything                                                                                  |
| API response to the dashboard or service worker | Versions drift: an old extension build can talk to a newer API                                                |
| Content script to service worker                | The sender runs inside third-party pages, so it is untrusted ([ADR 0012](0012-service-worker-api-gateway.md)) |
| Messages between extension contexts             | JSON serialization drops `Date`, `Map`, `Set` and `Error`, and turns `undefined` into `null`                  |
| Environment into the API process                | Operator mistakes                                                                                             |

The monorepo ([ADR 0001](0001-pnpm-workspaces-monorepo.md)) allows one definition per payload; the question is whether it should also validate at runtime.

## Decision

**Implemented (Phase 1):** zod 4 schemas are the single source of truth for TypeScript types (`z.infer`) and for runtime validation at every boundary above.

- **Shared contracts** live in `packages/shared`: `healthReportSchema`, `livenessReportSchema`, `apiErrorSchema` with stable `API_ERROR_CODES`, and `HEALTH_PATH`. Message schemas that only the extension uses live in `apps/extension/src/messaging/protocol.ts`.
- **API.** `fastify-type-provider-zod` validates requests and checks each response against its per-status schema before serializing it (on `/health`, 200 and 503 share one schema). Invalid requests get a 400 `VALIDATION_FAILED` in the `ApiError` envelope.
- **Dashboard.** `getJson(path, schema, …)` in `apps/dashboard/src/lib/http.ts` parses every response, and drift becomes an `HttpError` of kind `invalid-response`. The function only needs a `parse` method (`Parser<T>`).
- **Extension.** The service worker parses API responses. Message receivers check `sender.id`, parse the message with a zod discriminated union, and reply with an explicit `{ ok, data | error }` result that the caller also validates.
- **Configuration.** `apps/api/src/config/env.ts` validates `process.env` at startup and fails fast.

Contract rules:

- **No `.transform()`.** `fastify-type-provider-zod` 7 serializes responses with zod's encode API, so a one-way transform in a response schema fails type-checking and returns 500 at runtime. Use `z.codec` for two-way conversions.
- **Dates are ISO-8601 strings** (`z.iso.datetime()`), and keys are camelCase.
- **Clients branch on `error.code`**, never on the message text.
- **One zod version** from the pnpm catalog, imported as `import { z } from 'zod'`.

## Alternatives considered

| Option                                              | Why not                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript types only                               | No runtime cost and no protection: the service worker would trust whatever a page-hosted script sends.                                                                                           |
| JSON Schema or TypeBox with Ajv (Fastify's default) | Fastest on the server, but Ajv compiles validators with `new Function`, which the MV3 CSP blocks. Precompiled standalone validators avoid that but add a build step and a second schema dialect. |
| OpenAPI-first with codegen                          | Pays off for public or polyglot clients; every client here is TypeScript in this repository. OpenAPI can still be generated from zod later.                                                      |
| tRPC                                                | Ties clients to an RPC transport, does not cover `chrome.runtime` messaging, and conflicts with the versioned REST API ([API](../api.md)).                                                       |
| Valibot or `zod/mini`                               | Smaller bundles; kept for shrinking the content script, not as a second source of truth.                                                                                                         |

## Consequences

### Positive

- One definition per payload for producer and consumer.
- Drift fails at the boundary with a typed error.
- Foreign senders and unknown message shapes are rejected (`FORBIDDEN`, `BAD_REQUEST`) before any handler runs.

### Negative and trade-offs

- **Content-script size (R-15).** In Phase 1 `content.js` was about 89 kB (26 kB gzip), mostly zod. Since Phase 5 the content script reads its few messages with hand-written readers that tests keep equal to the zod schemas, and the worker still validates everything a content script sends with zod (26 kB, budget enforced by the build).
- **Blocked JIT probe.** zod 4 calls `new Function` once to test for JIT support. The extension CSP blocks it and zod falls back, but the attempt can surface as a CSP violation report. `z.config({ jitless: true })` skips the probe; it is not set yet.
- **Shared version.** A zod major upgrade touches every app.
- **Build order.** The production API needs the compiled `packages/shared/dist` ([ADR 0011](0011-source-first-workspace-packages.md)).
- **Unenforced rule.** No lint rule catches `.transform()`.

### Follow-ups

- **Planned (Phase 3):** contract tests for the guide endpoints.
- **Planned (Phase 5):** shrink the content script with `zod/mini` or hand-written guards, and set `z.config({ jitless: true })` in every extension entry point. Full zod stays in the service worker, which checks untrusted input.
- **Proposed:** generate an OpenAPI document from the schemas.

## References

- zod 4 versioning and import paths: https://zod.dev/v4/versioning
- `fastify-type-provider-zod`: https://github.com/turkerdev/fastify-type-provider-zod
- Fastify type providers: https://fastify.dev/docs/latest/Reference/Type-Providers/
- Ajv standalone code and CSP: https://ajv.js.org/standalone.html
- Chrome extension messaging: https://developer.chrome.com/docs/extensions/develop/concepts/messaging
