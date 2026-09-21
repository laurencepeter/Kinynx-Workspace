# Database Schema

PostgreSQL 16. Migrations live in
[`services/api/src/migrations`](../services/api/src/migrations) and are applied
automatically on API boot (and via `pnpm --filter @kinynx/api run migrate`).

## Migrations

| File | Contents |
|---|---|
| `0001_foundation.sql` | users, organizations + members, workspaces + members, pages, page_permissions, blocks, refresh_tokens, files, licenses, audit_logs |
| `0002_databases.sql` | databases, database_properties, database_records, record_relations, database_views, comments, pages FTS |

The runner is idempotent and tracks applied files in `schema_migrations`.

## Multi-tenancy

Tenant root is **organization**. A user joins many orgs
(`organization_members`); an org owns many workspaces. Never assume
`one user = one workspace`. Cascade deletes flow org → workspace → page → block.

```
users ─┬─< organization_members >── organizations ──< workspaces ──< pages ──< blocks
       └─< workspace_members >───────────────────────┘         └─< page_permissions
organizations ──< files, licenses, audit_logs
workspaces ──< databases ──< database_properties
                           ├─< database_records ──< record_relations
                           └─< database_views
workspaces ──< comments   (target_type: page|block|record)
```

## Key tables

### `users`
Argon2id `password_hash` (nullable — SSO/magic-link users have none).
`email_norm` is a generated lowercased column with a unique index for
case-insensitive uniqueness without the `citext` extension.

### `organizations`
`slug` unique; `domains TEXT[]` holds verified email domains used by Enterprise
SSO auto-discovery; `plan` mirrors the active entitlement.

### `pages`
Self-referential tree via `parent_id`. `position` is a lexicographic fractional
index for cheap reordering without renumbering siblings. Soft-deleted via
`archived_at`. `search_tsv` is a generated `tsvector` (GIN-indexed) over the
title for full-text search.

### `blocks`
First-class rows (not opaque JSON documents), each with a `type` and a JSONB
`content`. Self-referential (`parent_id`) for nesting. Storing blocks
individually keeps the editor decoupled from serialization and leaves room for
per-block CRDT/OT merging in Phase 2.

### `database_records`
Records are **first-class objects**, not HTML tables. `values JSONB` maps
`property_id → value`; a GIN index supports querying. Relations are explicit
rows in `record_relations` so rollups/relations are queryable.

### `refresh_tokens`
Only a **SHA-256 hash** of the token is stored. Rotation revokes the old row and
inserts a new one; expiry and `revoked_at` are enforced in the refresh query.

### `files`
Metadata only — **bytes live in object storage** (S3/MinIO/R2), referenced by
`storage_key`. Files are never stored in Postgres.

### `audit_logs`
Written cheaply for core events (e.g. `org.create`); Enterprise unlocks reading,
retention policies, and export.

## RLS-readiness

The schema is written so PostgreSQL Row-Level Security policies keyed on
`organization_id` / `workspace_id` can be layered on for defense-in-depth and
for Supabase-Realtime compatibility, without restructuring tables.
