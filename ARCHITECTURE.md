# Kinynx Architecture

## Guiding principles

1. **One codebase, three deployments.** The same core powers self-hosted,
   managed cloud, and enterprise. Editions differ by *entitlements*, not by
   forks. See [Licensing](docs/LICENSING.md).
2. **Open core, honestly.** Everything needed to run a genuinely useful
   workspace is Apache-2.0. Only organizational-scale/compliance features are
   commercial, and they live in a clearly separated `/enterprise` tree.
3. **Security is server-side.** Authorization is enforced in the API, never by
   hiding UI. See [Permissions](docs/PERMISSIONS.md).
4. **Abstractions at the seams.** Auth, storage, billing, AI, and search sit
   behind interfaces so providers can be swapped (S3↔R2↔MinIO,
   Postgres FTS↔Meilisearch, OpenAI↔Ollama, Stripe↔manual license).
5. **Portable data.** Templates are self-contained packages; nothing critical
   depends on a hosted marketplace or a phone-home license server.

## Component diagram

```
                         Internet / LAN
                              │
                        Caddy / Traefik  ── auto-TLS, routing
                              │
              ┌───────────────┴───────────────┐
         Web / Desktop / Mobile            API (Fastify)
                                               │
                 ┌─────────────────────────────┼───────────────────────────┐
             PostgreSQL                       Redis                  Object storage
        (source of truth,               (cache, jobs,             (S3 / MinIO / R2 —
         RLS-ready, FTS)                 realtime fan-out)          file bytes only)
```

## Technology choices

The product brief's preferred stack is **Flutter + Supabase/Postgres + Redis +
S3 + Caddy + Docker**. Two deliberate, documented adaptations:

- **API service in TypeScript (Fastify) over raw PostgreSQL** instead of pushing
  every feature through Supabase. The brief explicitly allows this ("Do not
  force every backend feature through Supabase if a dedicated service is
  architecturally better"). A dedicated API gives us first-class server-side
  authorization, an OpenAPI surface, integration/automation framework hooks, and
  clean provider abstractions. Supabase-compatible Postgres + Realtime can sit
  alongside it; the schema is written to be RLS-ready.
- **A vanilla-JS web client for the vertical slice** so the slice is runnable and
  reviewable today. `apps/web` is a thin reference client; a Flutter client
  (`apps/mobile`, `apps/desktop`) consumes the same HTTP/JSON API unchanged.

Nothing in the core couples the editor to the database engine or to a specific
frontend framework — the contract is the REST API in [docs/API.md](docs/API.md).

## Data model (multi-tenant)

```
User ──< OrganizationMember >── Organization
                                    │
                                 Workspace ──< WorkspaceMember >── User
                                    │
                                  Page (tree, parent_id) ──< PagePermission >── User
                                    │
                                  Block (tree, parent_id)

Workspace ── Database ── DatabaseProperty
                      └─ DatabaseRecord ──< RecordRelation
                      └─ DatabaseView
```

A user belongs to many organizations; an organization holds many workspaces.
Full schema and rationale: [docs/DATABASE.md](docs/DATABASE.md).

## Realtime & collaboration (Phase 2)

The block table stores blocks as individually addressable rows so the editor is
**not** coupled to a single serialization. This leaves room to layer CRDT/OT
(e.g. Yjs) per block or per page later. Presence, cursors, comments, mentions,
and notifications fan out over Redis pub/sub; the transport (WebSocket / SSE /
Supabase Realtime) is an implementation detail behind a `realtime` package.

## Abstractions (interfaces, not vendors)

| Seam | Interface | Initial impl | Future |
|---|---|---|---|
| Auth | `AuthProvider` | email/password, magic link | OIDC, SAML, LDAP, SCIM (EE) |
| Storage | `StorageDriver` | MinIO / S3 | R2, local FS |
| Search | `SearchEngine` | Postgres FTS | Meilisearch, OpenSearch |
| Billing | `BillingProvider` | manual license | Stripe, others |
| AI | `AIProvider` | none | OpenAI, Anthropic, Google, Ollama, OpenRouter, custom |
| Realtime | `RealtimeBus` | Redis pub/sub | Supabase Realtime |

## Development roadmap

- **Phase 1 — Foundation** *(implemented here)*: auth, org/workspace/page/block,
  Postgres schema, server-side permissions, licensing/feature system, Docker.
- **Phase 2 — Collaboration** *(largely implemented here)*: realtime presence +
  live-sync (WebSocket), page history/versioning, audit trail, groups,
  invitations (email/link), email provider abstraction, page linking/backlinks,
  color coding. *Remaining*: inline comments/mentions/notifications UI, live
  cursors, CRDT merge.
- **Phase 3 — Databases** *(core implemented here)*: typed properties, records,
  status-with-colors, progress rollups, reports; default table view. *Remaining*:
  board/calendar/gallery/timeline rendering, formulas, cross-database rollups.
- **Phase 4 — Templates**: `.template.zip` package format, import/export,
  marketplace, publishing, versioning.
- **Phase 5 — Enterprise**: SSO/LDAP/SCIM, audit logs, advanced RBAC/custom
  roles, org administration, enterprise licensing.
- **Phase 6 — Cloud**: hosted multi-tenant, billing, provisioning, usage
  monitoring, automated backups.
- **Phase 7 — AI**: provider abstraction, workspace RAG, local models,
  automation engine, agents.

Each phase keeps the application runnable.

## Security posture

Summarized in [SECURITY.md](SECURITY.md). Highlights: Argon2id password hashing,
short-lived JWT access tokens with rotating hashed refresh tokens, server-side
authorization on every route, Helmet headers, rate limiting, input validation
with Zod, offline license verification (no phone-home), and file bytes kept out
of Postgres.
