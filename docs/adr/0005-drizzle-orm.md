# ADR 0005: Drizzle ORM and Drizzle Kit migrations

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

The API needs typed PostgreSQL access from TypeScript and a migration workflow:

- one schema definition that produces both query types and migrations;
- migrations as plain SQL, reviewed in pull requests and applied the same way everywhere;
- predictable SQL, including the features chosen in [ADR 0004](0004-postgresql-primary-database.md): `jsonb`, arrays, partial and GIN indexes, check constraints;
- a small runtime that works with ESM, `tsx` and Vitest, without a code generation step.

## Decision

**Implemented (Phase 1, wiring only):**

- `drizzle-orm` 0.45.3 on node-postgres (`pg` 8.23). `apps/api/src/infrastructure/database/client.ts` creates the pool and `drizzle({ client: pool, schema, casing: 'snake_case' })`, and exposes a small `Database` interface (`db`, `ping()`, `close()`).
- The schema is TypeScript in `src/infrastructure/database/schema.ts`, intentionally empty until Phase 2.
- `drizzle-kit` 0.31.11 through `apps/api/drizzle.config.ts` (same `casing`; it loads the root `.env` itself). `generate`, `migrate` and `check` ran against PostgreSQL 18.
- `casing: 'snake_case'` in both files maps `createdAt` to `created_at`. Without it, columns keep the camelCase name.

**Planned (from Phase 2), workflow:** edit `schema.ts` → `pnpm db:generate` → review and commit the SQL with its `meta/` journal → `pnpm db:migrate`. Production runs migrations as a one-off job before rollout ([deployment](../deployment.md)). `drizzle-kit push` is not used against shared databases. Whatever the schema DSL cannot express, such as the `DEFERRABLE` unique constraint on step positions (absent in 0.45), goes into a custom migration (`drizzle-kit generate --custom`).

**Version policy:** stay on 0.45, npm's `latest` release. On 2026-10-04 Drizzle 1.0 is a release candidate (`1.0.0-rc.4`); upgrade once it is `latest`, as a dedicated change.

## Alternatives considered

- **Prisma.** Mature migration tooling. Why not: its own schema language (PSL) and a generated client to regenerate after every change, so a second schema language next to TypeScript and zod; a query API further from SQL and a heavier client.
- **TypeORM.** Why not: entity classes need legacy decorators and `reflect-metadata`, and our dev runner (`tsx`, built on esbuild) does not emit decorator metadata. Lazy relations hide how many queries run.
- **Kysely.** An excellent SQL-first query builder. Why not: no schema-as-code. Types are hand-written or generated from a live database (`kysely-codegen`) and migrations are hand-written, so the schema would have two sources.
- **Raw SQL with `pg`.** Full control. Why not: untyped results, manual row mapping, separate migration tooling, and a misspelled column fails only at runtime.

## Consequences

Positive:

- One TypeScript schema yields query types (inferred, no codegen) and migration diffs.
- The API stays close to SQL: joins and columns are explicit and nothing loads lazily, so N+1 patterns are visible. The `sql` template covers the rest. The health probe deliberately bypasses Drizzle: `Database.ping()` runs `select 1` through `pool.query` with node-postgres' per-query `query_timeout` (2 s), so a stalled database releases its pooled client instead of exhausting the pool (commit `4b04568`).
- Migrations are plain SQL in Git. Drizzle's PostgreSQL migrator applies pending migrations in one transaction, so with transactional DDL a failure leaves no partial schema.

Negative / trade-offs:

- 0.x churn and a pending 1.0 upgrade (risk R-18, [technical risks](../technical-risks.md)).
- `drizzle-kit generate` diffs snapshots and resolves renames through interactive prompts. A wrong answer becomes drop-and-create, so every generated file needs review.
- The migrator only applies migrations newer than the last applied one: a migration merged after a newer one was applied would be skipped. History must stay linear (regenerate after rebasing).
- The single transaction rules out statements such as `CREATE INDEX CONCURRENTLY`, which indexing large tables without long locks requires.
- `casing` must match in two files, or column names silently differ.

Follow-ups:

- **Implemented (Phase 2):** first tables and migration, committed with its `meta/` snapshot; table files live with their modules, one repository per module ([ADR 0002](0002-modular-monolith-backend.md)). drizzle-orm 0.45 has no `bytea` column type, so `infrastructure/database/columns.ts` adds a `customType`; constraint names are set explicitly because the API matches unique violations by name. `drizzle-kit check` runs in CI. No seed script.
- **Proposed:** evaluate Drizzle 1.0 once it becomes `latest`.

## References

- PostgreSQL setup: https://orm.drizzle.team/docs/get-started-postgresql
- Migrations: https://orm.drizzle.team/docs/migrations
- Custom migrations: https://orm.drizzle.team/docs/kit-custom-migrations
- Schema declaration and casing: https://orm.drizzle.team/docs/sql-schema-declaration
- node-postgres pool: https://node-postgres.com/apis/pool
