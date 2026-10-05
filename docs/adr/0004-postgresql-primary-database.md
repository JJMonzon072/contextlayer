# ADR 0004: PostgreSQL as the primary database

- Status: Accepted
- Date: 2026-10-04
- Deciders: JJ

## Context

The [proposed data model](../data-model.md) holds three kinds of data:

- **A relational core:** users, workspaces, memberships with roles, target applications, guides with ordered steps, immutable published versions and runs. A membership without a user, or two steps at the same position, is a bug.
- **Documents inside that core:** a versioned target descriptor per step ([ADR 0014](0014-element-targeting-strategy.md)), a rich-text body, version snapshots and event metadata.
- **An append-only event stream** for analytics (Phase 7).

Every tenant-owned row carries `workspace_id`, and tenant isolation is one of the main risks (R-17, [technical risks](../technical-risks.md)). The database must run locally at no cost ([ADR 0008](0008-local-first-development.md)) and be available from any hosting provider later.

## Decision

PostgreSQL 18 is the only database.

**Implemented (Phase 1):** `compose.yaml` runs `postgres:18-alpine` (18.6) on `127.0.0.1` only, with a named volume at `/var/lib/postgresql` (the PostgreSQL 18 image layout) and a `pg_isready` healthcheck. The API connects through `DATABASE_URL` with a pg pool, and `GET /health` probes it with `select 1`. The schema stays empty until Phase 2.

**Proposed (first migration in Phase 2):** the features the data model relies on.

| Need                                  | PostgreSQL feature                                                         |
| ------------------------------------- | -------------------------------------------------------------------------- |
| Integrity of memberships and guides   | Foreign keys, composite keys, check constraints for roles and statuses     |
| Reordering steps in one transaction   | `UNIQUE (guide_id, position) DEFERRABLE INITIALLY DEFERRED`                |
| Descriptors, rich text, snapshots     | `jsonb`, validated with zod before every write                             |
| Finding the application for an origin | `text[]` with a GIN index                                                  |
| Looking up active sessions            | Partial index `WHERE revoked_at IS NULL`                                   |
| Index-friendly primary keys           | Built-in `uuidv7()`, new in PostgreSQL 18 (checked on the local container) |
| All-or-nothing migrations             | Transactional DDL                                                          |
| Defense in depth for tenant isolation | Row-level security (considered later)                                      |

UUIDv4 keys spread inserts across the whole primary-key B-tree; UUIDv7 keys start with a timestamp, so new rows land near the right edge of the index. Because of `uuidv7()`, every environment needs PostgreSQL 18. If a managed provider lacks it, the API would generate the keys instead ([deployment](../deployment.md)).

## Alternatives considered

- **MongoDB.** Documents fit the target descriptor. Why not: memberships, ordered steps and version references need foreign keys and cascading deletes, which MongoDB leaves to application code; it has unique compound indexes, but no referential integrity and no deferrable uniqueness for reordering steps in one transaction. `jsonb` covers our documents without a second store.
- **SQLite.** Nothing to operate. Why not: one writer at a time, and the file lives with one process, so API replicas or a separate migration job cannot share it without replication tooling. No row-level security, and loose column typing.
- **MySQL 8.4.** Viable. Why not: no partial indexes, no deferrable constraints, no row-level security, and DDL commits implicitly, so a failed migration can leave a half-applied schema. JSON indexing (generated columns, multi-valued indexes) is narrower than GIN.
- **Proprietary cloud databases** (DynamoDB, Firestore). Why not: no local equivalent without emulators, and provider lock-in, against [ADR 0008](0008-local-first-development.md).

## Consequences

Positive:

- The database enforces integrity, not only the application code.
- One engine for relational data and documents; no second store to run or back up.
- Free, self-hostable, offered as a managed service by every major cloud, and supported by Drizzle ([ADR 0005](0005-drizzle-orm.md)).

Negative / trade-offs:

- `jsonb` has no schema inside the database. Shape guarantees come from the zod contracts and a `version` field in each descriptor, and frequently filtered fields should become real columns.
- A UUIDv7 reveals the row's creation time to anyone who sees the id. That is acceptable for workspace-internal resources.
- A single primary scales writes vertically. If `guide_events` grows large, the data model considers monthly partitioning.
- Self-hosting means owning backups and major-version upgrades.

Follow-ups:

- **Implemented (Phase 2):** first migration (`users`, `sessions`, `workspaces`, `workspace_members`), verified from an empty volume on PostgreSQL 18.6. The seed script was dropped (see [roadmap](../roadmap.md)).
- **Proposed:** row-level security as a second layer behind repository-level `workspace_id` filtering (R-17).
- **Planned (Phase 8):** backups and a restore drill.

## References

- UUID functions: https://www.postgresql.org/docs/18/functions-uuid.html
- JSON types: https://www.postgresql.org/docs/18/datatype-json.html
- Partial indexes: https://www.postgresql.org/docs/18/indexes-partial.html
- Row security policies: https://www.postgresql.org/docs/18/ddl-rowsecurity.html
- Transactional DDL: https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis
- MySQL implicit commits: https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
