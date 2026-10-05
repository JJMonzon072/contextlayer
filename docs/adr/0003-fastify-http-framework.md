# ADR 0003: Fastify as the HTTP framework

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

The API serves JSON over HTTP, and Phase 1 already fixed its requirements: validate every request and response against the zod contracts in `packages/shared` and derive handler types from them ([ADR 0010](0010-runtime-validated-shared-contracts.md)); one structured logger with request correlation; a plugin boundary per module ([ADR 0002](0002-modular-monolith-backend.md)); tests of the full HTTP pipeline without a port or a database; ESM on Node 22; security headers now, cookies and rate limiting in Phase 2.

## Decision

Use Fastify 5 (5.12.5). **Implemented (Phase 1)** in `apps/api/src/app.ts`:

- **Schema-first routes** with `fastify-type-provider-zod` 7. Its `validatorCompiler` and `serializerCompiler` are installed once, route schemas are zod schemas, and `request` and `reply.send()` are typed from them. Module plugins are typed `FastifyPluginAsyncZod`, because the type provider does not propagate into `register()`ed plugins.
- **Logging:** the pino instance from `src/logger.ts` is passed as `loggerInstance`; request ids come from `randomUUID()` and are echoed in `x-request-id`.
- **Errors:** `src/http/error-handler.ts` maps every error to the shared `ApiError` envelope (400 `VALIDATION_FAILED` for schema errors; 5xx details are logged, never returned). `@fastify/helmet` sets security headers.
- **Encapsulation:** each module is an encapsulated plugin. The `health` plugin's `onSend` hook sets `cache-control: no-store` on its own routes only.
- **Tests** call `app.inject()` on `buildApp()` with injected fakes.
- **Version policy:** stay on 5.x. On 2026-10-04 Fastify 6 is an alpha on npm's `next` tag.

Accepted trade-off: Fastify's fast serializer (fast-json-stringify) applies to JSON Schema responses. With the zod serializer, responses go through `z.safeEncode` and `JSON.stringify` instead: slower, but checked against the contract. We verified that undeclared fields (such as a stray `secret`) are stripped, and that a wrongly typed field becomes a 500 `ApiError` instead of a malformed body.

## Alternatives considered

- **Express 5.** The most used Node framework, and version 5 forwards rejected promises to the error handler. Why not: no schema-driven validation, serialization or type inference (each would be extra middleware), no plugin encapsulation, logging and request ids from third-party middleware, and lower throughput in Fastify's published benchmarks (not decisive at our scale).
- **NestJS.** Why not: its DI container, decorators and class-based DTOs would be a second way to describe every payload next to zod. It can run on Fastify, so it adds a layer rather than replacing one; that is too much framework for a one-developer API.
- **Hono.** Small, built on Web standards, multi-runtime, testable through `app.request()`. Why not: runtime portability is its main strength and we only target Node 22, where it needs an adapter. Rate limiting and pino logging are community packages, while Fastify has maintained `@fastify/*` plugins (`cookie`, `rate-limit`, `helmet`) that declare Fastify 5 support.

## Consequences

Positive:

- One zod schema per route gives runtime validation, handler types and, later, an OpenAPI document.
- `app.inject()` covers hooks, validation, serialization and the error handler; the 11 tests in `apps/api/test/health.test.ts` need no port and no database.
- Maintained plugins cover the Phase 2 needs.

Negative / trade-offs:

- Route files use Fastify APIs. Services and repositories are framework-free, which limits the cost of a switch.
- Serialization is slower than fast-json-stringify (see above).
- The type provider serializes with zod's encode, so a one-way `.transform()` in a response schema fails with a 500. Shared contracts use ISO date strings or `z.codec` ([ADR 0010](0010-runtime-validated-shared-contracts.md)).
- The type provider is a community package, and major upgrades of Fastify or zod can break it (risk R-18, [technical risks](../technical-risks.md)).

Follow-ups:

- **Planned (Phase 2):** `@fastify/cookie`, `@fastify/rate-limit` on the auth endpoints, and the CSRF `onRequest` guard ([ADR 0015](0015-authentication-strategy.md)).
- **Implemented (Phase 2):** `trustProxy` set from `TRUST_PROXY` (off by default), together with `@fastify/rate-limit`, so that `request.ip` (the default rate-limit key) is the client address; the API must be reachable only through the proxy ([deployment](../deployment.md)).
- **Proposed:** an OpenAPI document through `@fastify/swagger` and the provider's `jsonSchemaTransform`, for the Phase 3 contract tests.

## References

- Type providers: https://fastify.dev/docs/latest/Reference/Type-Providers/
- Validation and serialization: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- Encapsulation: https://fastify.dev/docs/latest/Reference/Encapsulation/
- Benchmarks: https://fastify.dev/benchmarks/
- fastify-type-provider-zod: https://github.com/turkerdev/fastify-type-provider-zod
- Express 5 migration guide: https://expressjs.com/en/guide/migrating-5.html
