# ADR 0008: Local-first, self-hosted development environment

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

Reviewers must be able to clone and run ContextLayer, and the owner must be able to work offline at zero cost. The runtime pieces are ordinary: a Node process, static files, PostgreSQL and a browser extension. Tying any of them to a cloud account (a managed database, hosted auth, SaaS analytics) would add sign-ups, cost and vendor-specific code before there is a user. It must still be deployable later.

## Decision

**Implemented (Phase 1):**

- **Compose runs only the stateful services; apps run on the host with pnpm.** `compose.yaml` defines one service: PostgreSQL 18 (`postgres:18-alpine`) with a `pg_isready` healthcheck, a named volume at `/var/lib/postgresql` and a default for every variable. `pnpm dev` runs the API (`tsx watch`), the dashboard (Vite) and the extension build in watch mode.
- **One root `.env`**, copied from `.env.example`, git-ignored, with local defaults only. It is read by:
  - Compose interpolation;
  - the API (`--env-file-if-exists`, validated by zod in `apps/api/src/config/env.ts`);
  - `drizzle.config.ts`;
  - the dashboard (Vite `loadEnv` with `envDir` at the root);
  - the extension build, which bakes in `EXTENSION_API_BASE_URL` and derives `host_permissions` from it.
- **Loopback by default.** PostgreSQL is published only on `127.0.0.1`, and both the API and Vite bind to `localhost`.
- **Infrastructure behind small seams.** `buildApp({ database, logger })` in `apps/api/src/app.ts` receives only the part of the `Database` interface it uses (`ping` and `close`; repositories will receive `db`) and an optional logger. Tests inject fakes; another PostgreSQL host is just a different `DATABASE_URL`.
- **No paid cloud or SaaS dependency**, in the code or in the dev loop. The `contextlayer`/`contextlayer` credentials are local-only.

## Deploying to a cloud later, without requiring one

Those seams make deployment a configuration task. The provider-agnostic shape is in [deployment](../deployment.md) and is **Planned (Phase 8)**:

| Concern          | Local (Implemented)               | Production (Planned)                                                                                                                                                                                      |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration    | Root `.env`                       | Environment variables or a secret store, same names                                                                                                                                                       |
| API              | `tsx watch`                       | Container running `node dist/server.js`, JSON logs to stdout                                                                                                                                              |
| Health           | `/health`, `/health/live`         | Readiness and liveness probes on the same endpoints                                                                                                                                                       |
| Shutdown         | `close-with-grace` (10 s)         | Same handler on SIGTERM                                                                                                                                                                                   |
| Dashboard to API | Vite proxy for `/api/*`           | Reverse proxy serving the static build and `/api/*` on one origin, with TLS                                                                                                                               |
| Database         | PostgreSQL 18 in Compose          | PostgreSQL 18, self-hosted or managed (the proposed schema uses the built-in `uuidv7()`; an older server would need application-generated ids, see [data model](../data-model.md#31-uuidv7-primary-keys)) |
| Migrations       | `pnpm db:migrate`                 | One-off job before each rollout                                                                                                                                                                           |
| Extension        | Built for `http://localhost:3000` | Built per environment with `EXTENSION_API_BASE_URL`                                                                                                                                                       |

Any platform that runs a container and can reach PostgreSQL will do: a VM with Compose, a container PaaS, a hyperscaler or Kubernetes. None of them is required, and no provider-specific code enters the codebase.

## Alternatives considered

| Option                                  | Why not                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps in containers too (a devcontainer) | Slower feedback: file watching through bind mounts on macOS can lag or miss events, and debugging gains a layer. The extension `dist` has to reach the host's Chrome anyway.  |
| Managed services for development        | Reviewers would need accounts, network access and maybe a paid plan; vendor SDKs couple code to a provider (see [ADR 0015](0015-authentication-strategy.md)).                 |
| PostgreSQL installed natively           | Versions drift between machines, and there is no one-command reset.                                                                                                           |
| SQLite in development                   | Loses parity on features the data model relies on: `uuidv7()`, JSONB, GIN-indexed arrays and deferrable unique constraints ([ADR 0004](0004-postgresql-primary-database.md)). |

## Consequences

### Positive

- Five commands from clone to a running stack: `corepack enable`, `cp .env.example .env`, `pnpm install`, `docker compose up -d`, `pnpm dev`.
- Works offline at no cost, on the production PostgreSQL major version.
- Unit tests run without Docker, against injected fakes.

### Negative and trade-offs

- Docker is a prerequisite.
- Local HTTP versus production HTTPS affects `Secure` and `__Host-` cookies ([ADR 0015](0015-authentication-strategy.md)).
- There are no local backups or monitoring.
- Every tool sees every variable in the shared `.env`; acceptable while it holds only local defaults.

### Follow-ups

- **Planned (Phase 2):** a seed script, and CI running the same pnpm commands (so the CI provider is replaceable).
- **Planned (Phase 8):** Dockerfiles, reverse-proxy configuration, backups and observability.

## References

- The Twelve-Factor App, Config: https://12factor.net/config
- Compose file reference: https://docs.docker.com/reference/compose-file/
- Official `postgres` image, data directory for 18+: https://hub.docker.com/_/postgres
