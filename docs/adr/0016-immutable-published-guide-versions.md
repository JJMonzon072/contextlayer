# ADR 0016: Mutable guide drafts, immutable published versions

- Status: Accepted
- Date: 2026-10-05
- Deciders: JJ

## Context

Authors edit a guide for days, while learners follow it in the real application (Phase 6) and their runs feed analytics (Phase 7). Three forces meet:

- **Half-finished edits must never reach learners.** A guide is edited step by step and saved often; a learner who opens it mid-edit would get a broken walkthrough.
- **History must stay meaningful.** A run records step positions (`guide_events.step_position`). If the steps it refers to can change later, completion and drop-off per step become meaningless.
- **Concurrency is real.** Two authors (or a dashboard tab and, from Phase 5, the side panel) can save and publish the same guide at the same time.

PostgreSQL 18 with Drizzle is the store ([ADR 0004](0004-postgresql-primary-database.md), [ADR 0005](0005-drizzle-orm.md)); guide content is untrusted JSON validated by zod ([ADR 0010](0010-runtime-validated-shared-contracts.md), [ADR 0014](0014-element-targeting-strategy.md)).

## Decision

**Implemented (Phase 3).** A guide has one mutable draft (`guides` and the ordered `guide_steps`) and any number of immutable published versions (`guide_versions`). Publishing copies the draft into a JSON snapshot; players and runs only ever use snapshots.

- **Snapshot.** `guide_versions.snapshot` holds `{ version: 1, guide: { id, applicationId, title, description, startUrlPattern }, steps: [...] }`, validated by `guideSnapshotSchema` (`packages/shared/src/guides.ts`) before it is written. It never references `guide_steps` rows, so nothing done to the draft afterwards can reach it.
- **Immutability is enforced by PostgreSQL**, not only by the absence of routes. The guarantee is precisely:
  - **Content and identity never change.** A `BEFORE UPDATE` trigger (`drizzle/0002_content_constraints.sql`) rejects any update that touches `id`, `guide_id`, `version`, `guide_revision`, `snapshot` or `published_at`.
  - **Only the publisher can be anonymized.** The one update the trigger lets through sets `published_by` to `NULL` and changes nothing else. That is how `ON DELETE SET NULL` anonymizes the publisher when their account is deleted. The trigger cannot tell that from a manual `UPDATE … SET published_by = NULL`, so such an update is also accepted; it removes attribution only, never content.
  - **Versions are never deleted.** A `BEFORE DELETE` trigger (`drizzle/0003_protect_published_versions.sql`, added after the Phase 3 review) rejects every delete, including direct SQL. Both triggers use SQLSTATE `23000`.
  - **Not covered:** `TRUNCATE` does not fire row triggers; it remains an owner-level maintenance operation (the test suite uses it to reset its database).
  - **Defense in depth:** `guide_versions → guides` is `ON DELETE RESTRICT`, and the API has no route that changes or deletes a version.
- **One writer at a time per guide.** Every draft change (`PATCH`), step replacement (`PUT …/steps`), archive and publish runs in a transaction that first takes `SELECT … FOR UPDATE` on the guide row. A snapshot therefore never mixes two drafts, and version numbers are assigned in order; `unique (guide_id, version)` backs this up.
- **Draft revision.** `guides.revision` increases on every draft change, and each version records the revision it froze (`guide_revision`). This gives three things with one integer:
  - "Unpublished changes" is `revision ≠ latest version's revision`.
  - Optimistic concurrency: `PUT …/steps` must send `expectedRevision`, and a stale one gets 409 instead of overwriting another author's work.
  - Idempotent publishing: publishing an unchanged draft returns the latest version (200) instead of creating a duplicate, so double clicks and racing publishes yield exactly one new version.
- **Status.** `draft` (never published), `published` (at least one version; the draft stays editable), `archived` (hidden from players, read-only; versions kept, can be restored).

## Alternatives considered

| Option                                                    | Why not                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Players read the live `guides` and `guide_steps` rows     | Draft edits leak to learners, and analytics positions drift as steps move.                                                                   |
| Versioned step rows (copy-on-write, `version_id` columns) | Every query needs a version filter; publishing touches many rows; immutability is harder to enforce than for one row.                        |
| Event sourcing of guide edits                             | Much more machinery than an MVP needs; snapshots are still required for fast reads.                                                          |
| `max(version) + 1` without a lock                         | Two concurrent publishes compute the same number; the unique constraint would turn one into an error instead of an idempotent answer.        |
| Compare draft and snapshot JSON to detect changes         | Needs canonical JSON (jsonb reorders keys) and reads up to ~1.6 MB per check; a counter is exact for "something was saved since", and cheap. |

## Consequences

- **Positive:** learners and analytics see frozen content; published history cannot be rewritten or deleted even by a bug or a manual `UPDATE` or `DELETE` (only the publisher attribution can be cleared); concurrent authors cannot silently overwrite each other; publishing is safe to retry.
- **Negative:** each version duplicates its content (bounded: at most 50 steps, each with a descriptor of up to 16 KB and 2000 characters of instructions); ids inside the snapshot are not foreign-key checked; saving content without changing it still counts as a new revision.
- **Follow-ups:**
  - **Planned (Phase 4):** the extension fetches the latest version of non-archived guides for an origin.
  - **Planned (Phase 7):** runs reference `guide_versions.id`.
  - **Proposed:** pinning an older version as live (rollback), [data model open question 4](../data-model.md#9-open-questions); a purge job for archived guides that deletes in dependency order (it would have to disable the delete trigger deliberately, as the table owner, with `ALTER TABLE guide_versions DISABLE TRIGGER`).

## References

- PostgreSQL row locking (`FOR UPDATE`): https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS
- PostgreSQL trigger functions: https://www.postgresql.org/docs/18/plpgsql-trigger.html
- Deferrable constraints: https://www.postgresql.org/docs/18/sql-createtable.html
