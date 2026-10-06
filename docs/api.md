# API

> **Status.** **Implemented (Phase 1):** `GET /health` and `GET /health/live`, the `ApiError` envelope, request ids, security headers, and zod validation and serialization. **Implemented (Phase 2):** the `auth` and `workspaces` modules under `/v1` ([section 3.2](#32-phase-2-auth-and-workspaces)), dashboard sessions, the CSRF guard and auth rate limits ([ADR 0015](adr/0015-authentication-strategy.md)). **Implemented (Phase 3):** the `applications` and `guides` modules ([section 3.3](#33-phase-3-applications-guides-and-publishing)), cursor pagination and immutable published versions ([ADR 0016](adr/0016-immutable-published-guide-versions.md)). **Implemented (Phase 4):** the `extension` module ([section 3.4](#34-phase-4-extension-connection-and-published-guides)): connection codes, token exchange with strict refresh rotation, revocation, connected browsers and published guides by origin ([ADR 0015](adr/0015-authentication-strategy.md), now Accepted for the extension too). Every other endpoint is **Planned** for the phase shown.

Related: [architecture](architecture.md), [data model](data-model.md), [ADR 0002](adr/0002-modular-monolith-backend.md), [ADR 0003](adr/0003-fastify-http-framework.md), [ADR 0010](adr/0010-runtime-validated-shared-contracts.md), [ADR 0012](adr/0012-service-worker-api-gateway.md), [deployment](deployment.md).

## 1. Conventions

- **JSON only** (`application/json; charset=utf-8`). Any other content type gets a 415. The `text/plain` parser is removed (Implemented, Phase 2), because it is one of the content types a cross-site form can send without a CORS preflight.
- **camelCase payloads.** snake_case exists only in SQL, mapped by Drizzle `casing: 'snake_case'`.
- **Paths:** plural nouns. Tenant resources nest under `/v1/workspaces/:workspaceId/…`, so authorization is one membership lookup and every log line names the tenant. Path ids are validated as UUIDs (a malformed id is a 400, not a database error). Non-CRUD actions are `POST` sub-resources (`/publish`).
- **Status codes:** `GET`/`PATCH`/`PUT` return 200, a create returns 201 with the resource, `DELETE` returns 204.
- **Values:** UUID strings, ISO 8601 UTC timestamps, and no `.transform()` in shared schemas ([ADR 0010](adr/0010-runtime-validated-shared-contracts.md)).
- **No CORS** (Implemented, by design; see section 2).

### 1.1 Versioning (Implemented, Phase 2)

Business routes live under `/v1`. Health stays unversioned, because probes are infrastructure, not a product contract. The dashboard ships with the API, but installed extensions update on Chrome's schedule (enterprise channels can pin a version), so the API keeps serving at least the previous extension release. Additive changes (new endpoints, new optional fields) stay in `v1`, and clients ignore unknown fields because zod objects strip them. Breaking changes go to `/v2`, served next to `v1` for a deprecation window.

### 1.2 Error envelope (Implemented)

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found",
    "requestId": "41b3032b-dadc-4b52-a064-051fb377f734"
  }
}
```

The codes are `API_ERROR_CODES` in `packages/shared/src/api-error.ts`. The mapping is in `apps/api/src/http/error-handler.ts`:

| `code`                | HTTP                | When                                                                                       | `message`                                                       |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `VALIDATION_FAILED`   | 400                 | zod rejected params, query or body                                                         | `Request validation failed`                                     |
| `BAD_REQUEST`         | 400 or unmapped 4xx | malformed JSON (400); unsupported media type (415); body too large (413)                   | Fastify's text for `FST_*` errors, else `Bad request`           |
| `UNAUTHORIZED`        | 401                 | no valid session; wrong email or password on login                                         | `Authentication required` / `Invalid email or password.`        |
| `FORBIDDEN`           | 403                 | the caller's role refuses; the CSRF guard refuses                                          | a module message (section 3.2) / `Cross-site request rejected.` |
| `NOT_FOUND`           | 404                 | unknown route or method; a workspace the caller is not a member of                         | `Route not found` / a module message                            |
| `CONFLICT`            | 409                 | email already registered; already a member; last owner                                     | a module message (section 3.2)                                  |
| `RATE_LIMITED`        | 429                 | auth rate limit exceeded, with `retry-after`                                               | `Too many requests`                                             |
| `INTERNAL_ERROR`      | 500                 | any 5xx except 503; an error without a 4xx/5xx status; a response that violates its schema | `Internal server error`                                         |
| `SERVICE_UNAVAILABLE` | 503                 | an error thrown with status 503                                                            | `Service temporarily unavailable`                               |

An unmapped 4xx keeps its real HTTP status and uses `BAD_REQUEST`. The 503 from `GET /health` is a `HealthReport`, not an `ApiError`. Module errors (section 6) carry their own client-safe messages; anything else thrown with a 4xx gets the generic message above, so an internal message never reaches the client.

### 1.3 Request ids (Implemented)

`genReqId` assigns `randomUUID()` to every request. An `onRequest` hook returns it as `x-request-id`, including on 404s and errors, and it also appears as `error.requestId` and on every log line of the request. Fastify 5 ignores incoming `request-id` headers by default (`requestIdHeader: false`), so clients cannot inject ids into the logs. Proposed for Phase 8: accept the id that the reverse proxy sets.

### 1.4 Pagination (Implemented, Phase 3)

`?limit=` (1–100, default 20) and an opaque `?cursor=`, returning `{ "items": [...], "nextCursor": null }` (`pageQuerySchema` and `pageSchema` in `packages/shared/src/pagination.ts`).

- Lists are ordered newest first by UUIDv7 `id`, which is unique, immutable and time-ordered. A keyset query (`where id < $cursor order by id desc limit $limit + 1`) therefore never skips or repeats a row, even while other rows are inserted or edited between pages. The extra row only tells whether a next page exists.
- The cursor is `base64url(JSON.stringify({ v: 1, id }))` (`apps/api/src/http/cursor.ts`). Clients treat it as opaque; the API decodes and validates it, and a cursor it did not issue gets 400 `Invalid cursor.`.
- Indexes: `applications (workspace_id, id)` (its unique constraint), `guides (workspace_id, id desc)` and `guides (workspace_id, application_id, id desc)`.
- Offsets were rejected: they skip or repeat rows under concurrent inserts and slow down with depth. Sorting by a mutable key such as `updated_at` was rejected for the same reason. The cost is no page jumps or totals, which these screens do not need.

### 1.5 Idempotency

- `POST …/publish` (Implemented, Phase 3) returns the latest version with 200 when the draft has not changed since, so a double click or a retry never creates a second version ([ADR 0016](adr/0016-immutable-published-guide-versions.md)).
- `DELETE …/guides/:guideId` (archive) and `POST …/restore` are idempotent (Phase 3).
- `PUT …/steps` is a full replacement guarded by `expectedRevision`: replaying it after a lost response gets 409, and the client reloads the draft instead of overwriting newer work.
- `POST /v1/analytics/events`: each event carries a `clientEventId`. Duplicates are acknowledged but stored once, and the response is `{ accepted, duplicates }` (Phase 7, [data model 3.7](data-model.md#37-idempotent-event-ingestion)).
- `POST /v1/extension/token` is deliberately **not** idempotent for refresh tokens (Implemented, Phase 4): a refresh token works once, and presenting it again revokes the grant, with no grace window. A refresh answer lost after the server rotated therefore ends the connection, and the user connects again ([ADR 0015](adr/0015-authentication-strategy.md)).
- Other creates are not idempotent; the dashboard prevents double submission. No generic `Idempotency-Key` header is planned.

### 1.6 Rate limiting (Implemented, Phase 2)

`@fastify/rate-limit` 11, registered with `global: false`: only routes that opt in are limited.

| Route                      | Key               | Default limit (env)                               |
| -------------------------- | ----------------- | ------------------------------------------------- |
| `POST /v1/auth/login`      | client IP + email | 10 per 15 min (`LOGIN_RATE_LIMIT_MAX`)            |
| `POST /v1/auth/register`   | client IP         | 20 per 15 min (`REGISTER_RATE_LIMIT_MAX`)         |
| `POST /v1/extension/codes` | client IP         | 30 per 15 min (`EXTENSION_CODE_RATE_LIMIT_MAX`)   |
| `POST /v1/extension/token` | client IP         | 120 per 15 min (`EXTENSION_TOKEN_RATE_LIMIT_MAX`) |

- The window is `AUTH_RATE_LIMIT_WINDOW_SECONDS` (900). The login key is computed in a `preHandler`, after body validation, and the email is lower-cased, so changing its case does not reset the count.
- Responses are `429 RATE_LIMITED` with `retry-after`. An `errorResponseBuilder` turns the plugin's rejection into an error with status 429, so the shared error handler builds the envelope like any other error.
- The store is in memory. That is fine for one process; a second replica needs a shared store ([deployment](deployment.md)).
- `TRUST_PROXY` must name the reverse proxy, or `request.ip` is the proxy's address and every client shares one bucket. With an empty list, `X-Forwarded-For` is ignored, so a client cannot pick its own key.
- No global limit yet: every other route requires a session. A global limit is revisited in Phase 8.

### 1.7 Caching and headers

- **Implemented:** the health plugin's encapsulated `onSend` hook sets `cache-control: no-store`. `@fastify/helmet` defaults apply everywhere: `content-security-policy: default-src 'self'; …`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `strict-transport-security`, `cross-origin-resource-policy: same-origin`, `x-frame-options: SAMEORIGIN`.
- **Implemented (Phase 2):** `cache-control: no-store` on every `/v1` response, so tenant data never sits in a cache.
- **Proposed:** an `ETag` on `GET /v1/extension/guides`, so the service worker can revalidate cheaply.

## 2. Clients and authentication

| Client                             | Reaches the API                                                                                                                                                                                                                                                                                      | Credential                                                                                     | Status                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| Dashboard                          | same origin `/api/*`; the prefix is stripped by the Vite dev (5173) and preview (4173) proxy, and by a reverse proxy in production. No CORS.                                                                                                                                                         | opaque session cookie: HttpOnly, Secure, SameSite=Strict, `__Host-` in production. CSRF guard. | Implemented (Phase 2) |
| Extension service worker           | `EXTENSION_API_BASE_URL` directly. `host_permissions` pins that exact origin, port included, so no CORS while the grant is active. If the user withholds site access, requests fail; the worker detects it and the popup explains it (Phase 4). CORS for the pinned extension origin stays Proposed. | `Authorization: Bearer <opaque token>`, `credentials: 'omit'`, `redirect: 'error'`             | Implemented (Phase 4) |
| Content scripts, popup, side panel | never; they message the service worker ([ADR 0012](adr/0012-service-worker-api-gateway.md))                                                                                                                                                                                                          | none                                                                                           | Implemented rule      |
| Probes                             | `/health`, `/health/live`                                                                                                                                                                                                                                                                            | none                                                                                           | Implemented           |

Rules ([ADR 0015](adr/0015-authentication-strategy.md); Implemented for the dashboard in Phase 2 and for the extension in Phase 4):

- Every route accepts exactly one kind of credential. Cookie routes refuse any `Authorization` header with 401, even with a valid cookie; bearer routes never read cookies, and an invalid or missing token never falls back to one. The extension also omits cookies, because cookies are [not isolated by port](https://www.rfc-editor.org/rfc/rfc6265#section-8.5): in development, a cookie set through `localhost:5173` also reaches `localhost:3000`.
- Measured in Chromium 153 (Phase 4 spike): service-worker POSTs carry `Origin: chrome-extension://<id>` and `Sec-Fetch-Site: none`, GETs no `Origin`. The API cannot recognize the extension by origin, so the extension has its own tokens.
- A bearer token is bound to one workspace through its grant: extension routes take the workspace from the grant, never from the request.
- No credential → 401. Not a member → 404, identical to a workspace that does not exist (same code and message). A member with an insufficient role → 403. An integration test runs this matrix for every workspace route.

CSRF guard for unsafe methods (Implemented, Phase 2: `apps/api/src/http/csrf-guard.ts`, an `onRequest` hook, so it runs before body parsing and before any route work). Web pages send `Origin` on every non-GET/HEAD request (as `null` from opaque origins, which the guard rejects). Bearer requests skip the guard; a made-up bearer gains nothing on a cookie route, which refuses any `Authorization` header. `POST /v1/extension/token` is exempt by route configuration (`config.csrf: false`) because it reads no cookie and authenticates with the credential in its body.

| Request                                                | Result                                  |
| ------------------------------------------------------ | --------------------------------------- |
| `GET`, `HEAD`, `OPTIONS`                               | pass                                    |
| `Authorization: Bearer …`                              | guard skipped; cookie routes answer 401 |
| `Origin` in the `DASHBOARD_ORIGIN` allow-list          | pass                                    |
| `Origin` present but not allowed                       | 403 `FORBIDDEN`                         |
| no `Origin`, `Sec-Fetch-Site: same-origin`             | pass                                    |
| no `Origin`, any other `Sec-Fetch-Site` (incl. `none`) | 403 `FORBIDDEN`                         |
| neither header (curl, tests)                           | pass; a valid session is still required |

In development the allow-list holds `http://localhost:5173` and `http://localhost:4173` (preview); in production `DASHBOARD_ORIGIN` is required. The guard never compares `Origin` with `Host`, because the Vite proxy's `changeOrigin` rewrites `Host` to the API while `Origin` stays the dashboard's (in Vite 8.3.2, http-proxy-3 only sets `Host`; Vite rewrites `Origin` only for WebSocket upgrades with `rewriteWsOrigin`). The Playwright suite exercises this through the real preview proxy: every dashboard write passes the guard.

The extension connection flow (one-time code + PKCE through `externally_connectable`) is described in [ADR 0015](adr/0015-authentication-strategy.md); its endpoints are in [section 3.4](#34-phase-4-extension-connection-and-published-guides).

## 3. Implemented endpoints

### 3.1 Phase 1: health

#### `GET /health` (readiness)

`apps/api/src/modules/health/` probes PostgreSQL through `Database.ping({ timeoutMs })`, which runs `select 1` with node-postgres' per-query `query_timeout`. The bound is 2,000 ms (`HEALTH_PROBE_TIMEOUT_MS` in `apps/api/src/app.ts`), and the health service also enforces it. A timed-out client is destroyed rather than returned to the pool (max 10 connections), so health checks against a stalled database cannot exhaust it.

- **200** with `status: "ok"` when the database is up; **503** with `status: "unavailable"` otherwise.
- Both statuses declare `healthReportSchema` (`packages/shared/src/health.ts`), so the body is validated on the way out and clients always get a precise state.
- The failure reason is logged at `warn` ("health probe failed") and never returned.
- Headers: `cache-control: no-store`, `x-request-id`.
- Fastify also answers `HEAD /health`, which runs the probe too.

```json
{
  "status": "ok",
  "service": "contextlayer-api",
  "version": "0.0.0",
  "timestamp": "2026-10-04T19:21:55.925Z",
  "uptimeSeconds": 3600,
  "checks": { "database": { "status": "up", "latencyMs": 2 } }
}
```

When PostgreSQL is down, the same shape arrives with HTTP 503:

```json
{
  "status": "unavailable",
  "service": "contextlayer-api",
  "version": "0.0.0",
  "timestamp": "2026-10-04T19:29:04.794Z",
  "uptimeSeconds": 3720,
  "checks": { "database": { "status": "down", "latencyMs": 2000 } }
}
```

- `version` comes from `apps/api/package.json`. `uptimeSeconds` and `latencyMs` are rounded, and `latencyMs` includes timeouts.
- The dashboard calls `getJson(HEALTH_PATH, healthReportSchema, { acceptedStatuses: [200, 503] })` through `/api/health` and aborts it after 5 s.
- The service worker's `fetchApiHealth()` has a 5 s timeout and accepts 200 and 503.

#### `GET /health/live` (liveness)

Returns **200** `{ "status": "ok" }` with `no-store` and checks no dependencies. Liveness and readiness are separate on purpose: an orchestrator restarts a container that fails liveness, so a liveness check that touched PostgreSQL would restart every healthy instance during a database outage. Failing readiness only takes an instance out of the load balancer.

### 3.2 Phase 2: auth and workspaces

Contracts: `packages/shared/src/auth.ts` and `workspaces.ts`. Code: `apps/api/src/modules/auth/` and `modules/workspaces/`. Every route below answers `cache-control: no-store`; every unsafe one passes the CSRF guard first.

| Endpoint                                             | Request body                            | Success                                         | Errors                                                                              |
| ---------------------------------------------------- | --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /v1/auth/register`                             | `{ email, password, displayName }`      | 201 `{ user, workspaces: [] }` + cookie         | 400, 403 (CSRF), 409 email taken, 429                                               |
| `POST /v1/auth/login`                                | `{ email, password }`                   | 200 `{ user, workspaces }` + cookie             | 400, 401 `Invalid email or password.`, 403 (CSRF), 429                              |
| `POST /v1/auth/logout`                               | none                                    | 204, cookie cleared                             | 401, 403 (CSRF)                                                                     |
| `GET /v1/auth/session`                               | none                                    | 200 `{ user, workspaces }`                      | 401 (and the stale cookie is cleared)                                               |
| `GET /v1/workspaces`                                 | none                                    | 200 `{ items: WorkspaceSummary[] }`             | 401                                                                                 |
| `POST /v1/workspaces`                                | `{ name }` (trimmed, 1–80 characters)   | 201 `WorkspaceSummary`, caller is owner         | 400, 401, 403 (CSRF)                                                                |
| `GET /v1/workspaces/:workspaceId`                    | none                                    | 200 `WorkspaceSummary` (with the caller's role) | 400 malformed id, 401, 404                                                          |
| `GET /v1/workspaces/:workspaceId/members`            | none                                    | 200 `{ items: Member[] }`                       | 401, 404                                                                            |
| `POST /v1/workspaces/:workspaceId/members`           | `{ email, role }` (an existing account) | 201 `Member`                                    | 401, 403 role, 404 workspace or `No account uses this email.`, 409 already a member |
| `PATCH /v1/workspaces/:workspaceId/members/:userId`  | `{ role }`                              | 200 `Member`                                    | 401, 403 role, 404, 409 last owner                                                  |
| `DELETE /v1/workspaces/:workspaceId/members/:userId` | none                                    | 204                                             | 401, 403 role, 404, 409 last owner                                                  |

- **Shapes.** `user` is `{ id, email, displayName, createdAt }`; `WorkspaceSummary` is `{ id, name, role, createdAt }`, where `role` is the caller's; `Member` is `{ userId, email, displayName, role, joinedAt }`. No response contains a password hash, token or token hash.
- **Passwords.** 12–256 characters, no composition rules (OWASP, NIST SP 800-63B); stored only as argon2id hashes. Login verifies against a dummy hash for unknown emails, so the response time does not reveal whether an account exists.
- **Sessions.** Register and login issue a new session and revoke the one the browser presented, if any. A session ends after 30 min without requests or 8 h after sign-in (configurable); `last_seen_at` is written at most once a minute.
- **Roles.** Any member reads the workspace and its member list. `admin` and `owner` add, change and remove members; only an `owner` grants the `owner` role or changes or removes an owner. Anyone can leave by deleting their own membership. A workspace always keeps at least one owner (checked under a row lock on the workspace).
- **Registration creates no workspace.** The dashboard's onboarding asks for the first workspace's name instead of inventing one.
- **Adding members** requires an existing account. Invitations by email are out of scope until email delivery exists.

### 3.3 Phase 3: applications, guides and publishing

Contracts: `packages/shared/src/{applications,guides,origins,rich-text,target-descriptor,url-pattern,pagination}.ts`. Code: `apps/api/src/modules/applications/` and `modules/guides/`. Paths below are under `/v1/workspaces/:workspaceId`.

| Endpoint                                 | Request                                                         | Success                                     | Errors (besides 401, 403 CSRF, 404 workspace)      |
| ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `GET /applications`                      | `?limit&cursor`                                                 | 200 `{ items: Application[], nextCursor }`  | 400 cursor                                         |
| `POST /applications`                     | `{ name, origins }`                                             | 201 `Application`                           | 400, 403 role                                      |
| `GET /applications/:applicationId`       |                                                                 | 200 `Application`                           | 404                                                |
| `PATCH /applications/:applicationId`     | `{ name?, origins? }`                                           | 200 `Application`                           | 400, 403 role, 404                                 |
| `DELETE /applications/:applicationId`    |                                                                 | 204                                         | 403 role, 404, 409 has guides                      |
| `GET /guides`                            | `?applicationId&status&limit&cursor`                            | 200 `{ items: GuideSummary[], nextCursor }` | 400, 403 role                                      |
| `POST /guides`                           | `{ applicationId, title, description?, startUrlPattern? }`      | 201 `Guide`                                 | 400, 403 role, 404 application                     |
| `GET /guides/:guideId`                   |                                                                 | 200 `Guide` (draft with steps)              | 403 role, 404                                      |
| `PATCH /guides/:guideId`                 | `{ title?, description?, startUrlPattern?, expectedRevision? }` | 200 `Guide`                                 | 400, 403 role, 404, 409 archived or stale revision |
| `PUT /guides/:guideId/steps`             | `{ expectedRevision, steps: StepInput[] }`                      | 200 `Guide`                                 | 400, 403 role, 404 guide or foreign step, 409      |
| `POST /guides/:guideId/publish`          |                                                                 | 201 new version / 200 unchanged draft       | 403 role, 404, 409 no steps or archived            |
| `GET /guides/:guideId/versions`          |                                                                 | 200 `{ items: GuideVersionSummary[] }`      | 403 role, 404                                      |
| `GET /guides/:guideId/versions/:version` |                                                                 | 200 `GuideVersion` (with `snapshot`)        | 400 version number, 403 role, 404                  |
| `DELETE /guides/:guideId`                |                                                                 | 204, guide archived                         | 403 role, 404                                      |
| `POST /guides/:guideId/restore`          |                                                                 | 200 `Guide`                                 | 403 role, 404                                      |

- **Roles.** Any member reads applications. `admin` and `owner` create, change and delete them. Guides are authoring data: every guide route needs `editor` or above, and `member` gets 403. Learners receive published versions through the extension ([section 3.4](#34-phase-4-extension-connection-and-published-guides)). A non-member gets the same 404 as a workspace that does not exist; an id from another workspace inside your own workspace's URL gets the same 404 as a random id. Both are verified by a matrix test over every route.
- **Origins.** Exactly scheme, host and optional port; `http` or `https`; up to 20, no duplicates. They are stored the way browsers serialize `location.origin`: lower case, default port and trailing slash removed, punycode host. Paths, query strings, fragments, credentials, wildcards and other schemes get 400. A database CHECK repeats the essentials.
- **Shapes.**
  - `GuideSummary` has `revision`, `stepCount`, `latestVersion` (or `null`), `hasUnpublishedChanges` and `archivedAt`.
  - `Guide` adds `startUrlPattern` (URLPattern init) and the ordered `steps`: `{ id, position, title, body, target, urlPattern, placement }`.
  - `target` is a TargetDescriptor v1 or `null` (not captured yet).
- **Steps.** `PUT …/steps` replaces the whole list in one transaction.
  - The array order is the position (0…n−1); the request has no `position` field.
  - Steps with an `id` keep it; steps without one are created; steps left out are deleted.
  - Omitted optional fields take their defaults (`target: null`, `urlPattern: null`, `placement: "auto"`).
  - Ids of other guides are refused with 404 and nothing changes.
  - At most 50 steps; the route accepts bodies up to 2 MiB, since a list at its limits is about 1.6 MB.
- **Publishing.** Freezes the draft into the next version under the guide's row lock. Versions cannot be changed or deleted through the API, and the database rejects deleting them and any update other than clearing the publisher (`published_by = NULL`, used when an account is deleted) ([ADR 0016](adr/0016-immutable-published-guide-versions.md)).
- **Content.** `body` is the restricted rich-text v1 document: at most 20 blocks, 2000 characters and 200 text runs; links only `https:`. Unknown versions and unknown keys get 400, for bodies and descriptors alike.

### 3.4 Phase 4: extension connection and published guides

Contracts: `packages/shared/src/extension.ts`. Code: `apps/api/src/modules/extension/`. Paths are under `/v1/extension`.

| Endpoint                  | Auth                   | Request                                                                                                               | Success                                                               | Errors (besides 401)                             |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /codes`             | session + CSRF guard   | `{ workspaceId, codeChallenge, codeChallengeMethod: "S256", label? }`                                                 | 201 `{ code, expiresAt }` (60 s, single use)                          | 400, 403 CSRF, 404 workspace (not a member), 429 |
| `POST /token`             | credential in the body | `{ grantType: "authorization_code", code, codeVerifier, clientId }` or `{ grantType: "refresh_token", refreshToken }` | 200 `{ accessToken, accessTokenExpiresAt, refreshToken, connection }` | 400 invalid, expired or used code/token, 429     |
| `POST /revoke`            | bearer                 | optional `{ reason: "disconnected" \| "replaced" }`                                                                   | 204                                                                   | 400 reason                                       |
| `GET /session`            | bearer                 |                                                                                                                       | 200 `connection` (user, workspace, label, dates)                      | 404                                              |
| `GET /connections`        | session                |                                                                                                                       | 200 `{ items: Connection[] }` (the caller's, every workspace)         |                                                  |
| `DELETE /connections/:id` | session + CSRF guard   |                                                                                                                       | 204                                                                   | 403 CSRF, 404 (not yours, or unknown)            |
| `GET /applications`       | bearer                 |                                                                                                                       | 200 `{ items: [{ id, name, origins }] }` (at most 100)                |                                                  |
| `GET /guides`             | bearer                 | `?origin&limit&cursor`                                                                                                | 200 `{ items: PublishedGuideSummary[], nextCursor }`                  | 400 origin or cursor                             |
| `GET /guides/:guideId`    | bearer                 |                                                                                                                       | 200 `{ guideId, applicationId, version, publishedAt, snapshot }`      | 404                                              |

- **Bearer failures.** 401 with `WWW-Authenticate: Bearer realm="contextlayer-extension"`, plus `error="invalid_token"` when a token was sent (unknown, expired, revoked, or the user left the workspace).
- **Session.** The extension calls `GET /session` to check that its connection still stands: when the popup shows its status, and before a played guide moves to its previous or next step (Phase 6a), so a connection revoked from Connected browsers stops playback at the next step.
- **Codes.** Bound to the user, the workspace, the S256 challenge and, at exchange, the `clientId` (the extension id; `EXTENSION_ID` is required in production). A wrong verifier, an expired code or another client id gets 400. Presenting a consumed code again also revokes the grant it created (`code-replay`).
- **Rotation.** Each refresh returns a new refresh token; a used one revokes the grant (`refresh-reuse`); the grant's 30-day end is never extended. Concurrent refreshes with the same token: one wins, the grant is revoked as a reuse.
- **Connections.** `status` is `active`, `expired` or `revoked`; `revokedReason` is `disconnected`, `dashboard`, `replaced`, `refresh-reuse` or `code-replay`. `label` is a short browser name chosen by the dashboard ("Chrome on macOS").
- **Published guides.** By exact origin (normalized like application origins): only guides of applications of the grant's workspace that list that origin, only the latest published version, never archived guides; title, description, step count and start page (`startUrlPattern`, a URLPattern init or `null` for any page of the origin) come from the immutable snapshot, never from the draft. The API does not match the start page against a URL (Node has no URLPattern); the extension does, before listing a guide in the popup and again before playing it (Phase 6a). The detail returns the snapshot. Any member may read them. Two workspaces registering the same origin never see each other's guides.

### 3.5 Phase 5: guide authoring from the extension

Contracts: `packages/shared/src/extension.ts` (paths, `authoringCreateGuideRequestSchema`) and `guides.ts` (`guideSchema`, `replaceStepsRequestSchema`). Code: `apps/api/src/modules/extension/authoring.routes.ts`, a thin facade over the guides service, so revisions, transactions and tenant isolation are the dashboard's own. Paths are under `/v1/extension/authoring/applications/:applicationId/guides`. Only the extension's service worker calls them, for its Edit Mode side panel ([ADR 0018](adr/0018-side-panel-edit-mode.md)).

| Endpoint              | Request                                    | Success                                                     | Errors (besides 401)                                                                               |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /`               | `?limit&cursor`                            | 200 `GuideList` of the application (archived guides hidden) | 400 cursor, 403 role, 404 application                                                              |
| `POST /`              | `{ title }`                                | 201 `Guide` (an empty draft)                                | 400, 403 role, 404 application                                                                     |
| `GET /:guideId`       |                                            | 200 `Guide` (the draft, with its steps)                     | 403 role, 404 (unknown, other tenant, other application), 409 archived                             |
| `PUT /:guideId/steps` | `{ expectedRevision, steps: StepInput[] }` | 200 `Guide` with the new revision                           | 400 (descriptor, title, limits), 403 role, 404 (guide or a foreign step id), 409 revision/archived |

- **Bearer only.** The access check runs on `onRequest`, before the body is parsed; a request without a valid extension token is refused with 401 and never falls back to the dashboard cookie.
- **Workspace and role.** The workspace is the grant's, never a value from the client. The caller's current role is checked on every request: owner, admin and editor may read and write drafts; a member gets 403 on every route, reads included (members consume published versions only). A role lowered after the connection was made applies at once.
- **Consistency.** The application must belong to the grant's workspace and the guide to that application; anything else answers 404, exactly like an id that does not exist, so another tenant's ids are indistinguishable from unknown ones.
- **Step replacement** is the dashboard's: the array order is the position, steps keep their ids across reorders, a step without an id is new, a step id from another guide is 404, and `expectedRevision` must be the current revision (409 otherwise; the server never bumps it for the client). The body limit is 2 MiB. Published versions and their snapshots are never touched; publishing stays in the dashboard.

#### Unknown routes

All of these return **404** with `{ "error": { "code": "NOT_FOUND", "message": "Route not found", "requestId": "…" } }`:

- an unknown path;
- an unregistered method such as `POST /health`;
- `OPTIONS` (no CORS plugin is registered).

## 4. Modules and planned endpoints

API paths are listed as the API sees them; the dashboard adds the `/api` prefix. Roles (Implemented, Phase 2): `owner` > `admin` > `editor` > `member`, where "editor+" means `editor` or above. "Session" is the dashboard cookie and "bearer" is the extension token. The Phase 2, 3, 4 and 5 endpoints are in sections [3.2](#32-phase-2-auth-and-workspaces), [3.3](#33-phase-3-applications-guides-and-publishing), [3.4](#34-phase-4-extension-connection-and-published-guides) and [3.5](#35-phase-5-guide-authoring-from-the-extension); workspace routes never accept a bearer token.

| Module         | Owns                                         | Phase                 |
| -------------- | -------------------------------------------- | --------------------- |
| `health`       | none                                         | Implemented (Phase 1) |
| `auth`         | `users`, `sessions`                          | Implemented (Phase 2) |
| `workspaces`   | `workspaces`, `workspace_members`            | Implemented (Phase 2) |
| `applications` | `applications`                               | Implemented (Phase 3) |
| `guides`       | `guides`, `guide_steps`, `guide_versions`    | Implemented (Phase 3) |
| `extension`    | `extension_grants`, codes, both token tables | Implemented (Phase 4) |
| `analytics`    | `guide_runs`, `guide_events`                 | Planned (Phase 7)     |

| Endpoint                                                    | Purpose                                         | Auth             | Phase |
| ----------------------------------------------------------- | ----------------------------------------------- | ---------------- | ----- |
| `POST /v1/analytics/events`                                 | batched, idempotent ingestion                   | bearer           | 7     |
| `GET /v1/workspaces/:workspaceId/analytics/guides/:guideId` | runs, completion, per-step drop-off per version | editor+; session | 7     |

Members (learners) never read drafts, from the dashboard or from Edit Mode: they consume published versions through `GET /v1/extension/guides`. Whether members may see aggregates is open ([product](product.md)).

`GET /v1/extension/guides` takes `?origin=`, not `?url=` (Implemented, Phase 4): query strings are logged, and full customer URLs can contain record ids. The server only needs the origin to match `applications.origins`; the extension evaluates a guide's URL patterns itself (Phase 6).

## 5. Contracts

- **Where.** `packages/shared/src/<module>.ts` exports the zod schemas, their inferred types and the path constants. `health.ts` sets the pattern: `HEALTH_PATH`, `LIVENESS_PATH`, `healthReportSchema`, `livenessReportSchema`.
- **API (Implemented).** Routes declare `schema: { params, querystring, body, response: { <status>: schema } }` using shared schemas.
  - fastify-type-provider-zod's `validatorCompiler` validates requests; a failure becomes `VALIDATION_FAILED`.
  - Its `serializerCompiler` encodes responses with zod. A reply that breaks its own schema becomes a logged 500 instead of an unchecked body (verified with a deliberately wrong response).
  - Module plugins are typed `FastifyPluginAsyncZod`, because type providers do not carry over into registered plugins.
- **Dashboard (Implemented).** `request(method, path, { schema, body, acceptedStatuses, signal })` in `apps/dashboard/src/lib/http.ts` (with `getJson` as the GET shorthand) parses every response. Drift becomes `HttpError('invalid-response')`. Error responses are parsed as `ApiError`, so the error carries `code`, the API's `message` and `retry-after`. A 5xx with a body that is not ours (for example a proxy error page) counts as a `status` error, meaning the API is unavailable rather than out of contract. Forms validate with the same shared schemas before submitting.
- **Extension (Implemented).** The service worker parses API responses with the shared schemas, and runtime messages with `src/messaging/protocol.ts`.
- **Strictness (Implemented for Phase 3 contracts).** Request bodies of applications and guides use `z.strictObject`: unknown keys (a `workspaceId`, a `status`, a step `position`) get 400 instead of being silently dropped, which also rules out mass assignment. Stored documents (descriptor, rich text, snapshot) are strict at every level. Responses stay `z.object`, so older clients ignore new fields. Phase 2 request bodies still use `z.object`.
- **Normalizing without transforms.** Origins are normalized with zod's `.overwrite()`, which keeps the schema's type and its JSON representation ([ADR 0010](adr/0010-runtime-validated-shared-contracts.md) forbids `.transform()` in shared schemas).
- **Contract tests.** `packages/shared/test/content-contracts.test.ts` checks the limits (string lengths, array sizes, version 999, origin with a path, a step listed twice, oversize descriptors), and the integration tests parse responses with the shared schemas.

## 6. Module internal structure

```text
apps/api/src/modules/guides/
  guides.routes.ts               plugin: route schemas, status codes, error mapping
  guides.service.ts              use cases, transactions and row locks, role rules
  guides.repository.ts           Drizzle queries for guides and steps; every function takes workspaceId
  guide-versions.repository.ts   insert-only access to published versions
  guides.schema.ts               Drizzle tables (re-exported by infrastructure/database/schema.ts)
```

- **Wiring.** `buildApp()` (`apps/api/src/app.ts`) wires everything by hand: repository, then service, then routes. Health already works this way (`createHealthService(...)`, then `app.register(healthRoutes, { healthService })`); it has no repository because its probe is injected.
- **Registration.** Modules are registered without `fastify-plugin`, so their hooks stay local. `health` is registered at the root (unversioned); business modules are registered inside a `/v1` scope (Implemented, Phase 2).
- **Boundaries.** Modules call each other only through service interfaces injected in `buildApp()`, never through each other's tables ([architecture](architecture.md)). Example: `workspaces` reads user profiles through a `UserDirectory` that the `auth` service implements, and `auth` lists a user's workspaces through a function backed by the `workspaces` service. In Phase 3, `applications` and `guides` authorize through a `MembershipDirectory` (the caller's role, from `workspaces`), `guides` checks applications through an `ApplicationDirectory` and names publishers through a `PublisherDirectory` (`auth`).
- **Domain errors (Implemented, Phase 2).** Services return results such as `{ ok: false, error: 'last-owner' }` instead of throwing; each route plugin maps them to a status, code and client-safe message (`ERRORS` in `workspaces.routes.ts`). No generic `DomainError` class was needed.

## 7. OpenAPI (Proposed, later)

`@fastify/swagger` with `transform: jsonSchemaTransform` (exported by fastify-type-provider-zod 7) can generate an OpenAPI document from the same zod route schemas, and `@fastify/swagger-ui` could serve it in development. `@fastify/swagger` 9.9 is already installed as a peer of the type provider but is not registered. It is deferred because every current client is our own TypeScript code that imports the zod schemas, so the document would have no consumer. Triggers: an external integration (an MVP non-goal) or external contract testing.

## 8. Error-handling rules

1. Every non-2xx JSON response is an `ApiError`. The only exception is the 503 readiness report.
2. Never leak internals (**Implemented**):
   - a 5xx returns a generic message and is logged at `error` with its stack and the request id;
   - a 4xx is logged at `info` and returns its generic message, except Fastify's input-free `FST_*` messages.
3. Validation details: **Proposed (Phase 2, for forms)** an optional `details: [{ path, message }]` on `VALIDATION_FAILED`, built from zod issue paths and never echoing input values. It is an additive change.
4. Clients branch on `code`, never on `message`, and treat unknown codes as generic failures. A new code is a contract change in `packages/shared`.
5. Credentials stay out of logs and URLs. `authorization`, `cookie` and `set-cookie` are redacted (`apps/api/src/logger.ts`, **Implemented**), and tokens and codes travel only in headers or bodies. Login failures do not say which part was wrong.
6. New codes are added only when a client must branch on them; until then an unmapped 4xx keeps its status with `BAD_REQUEST`.
