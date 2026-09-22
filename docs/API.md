# API

REST/JSON over HTTP. All app routes are under `/api`. Authentication is a
Bearer access token (`Authorization: Bearer <token>`). Access tokens are
short-lived JWTs (15 min default); rotate with the refresh token.

> An OpenAPI 3.1 document is generated from the route schemas (Zod → JSON
> Schema) and served at `/api/openapi.json` (Phase 1.1). This file is the
> human summary.

## Conventions

- Bodies and responses are JSON. Timestamps are ISO-8601 UTC.
- Errors: `{ "error": string, "details"?: string }` with an appropriate status
  (`400` validation, `401` unauthenticated, `403` forbidden, `402` limit reached,
  `404` not found, `409` conflict).
- IDs are UUIDv4.

## System

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | no | Liveness + dependency checks (`api`, `database`) |
| GET | `/api/system/info` | no | Edition, plan, feature flags, limits |

## Auth

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | `{ email, password, display_name? }` → user + session |
| POST | `/api/auth/login` | `{ email, password }` → session |
| POST | `/api/auth/refresh` | `{ refresh_token }` → new session (rotates token) |
| POST | `/api/auth/logout` | `{ refresh_token }` → 204 (revokes token) |
| POST | `/api/auth/magic-link/request` | `{ email }` → emails a single-use sign-in link (always 200) |
| POST | `/api/auth/magic-link/verify` | `{ token }` → session (creates the user if new) |
| GET | `/api/auth/me` | current user |
| GET | `/api/auth/oidc/status` | whether OIDC/OAuth SSO is configured |
| GET | `/api/auth/oidc/login` | begin SSO — returns the IdP authorize URL |
| GET | `/api/auth/oidc/callback` | code exchange → session (provisions user by email) |

A **session** is `{ access_token, refresh_token, token_type: "Bearer", expires_in }`.

## Organizations

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/organizations` | member | Orgs the caller belongs to |
| POST | `/api/organizations` | — | Create org (caller becomes `owner`) |
| POST | `/api/organizations/:id/members` | admin | Add/update a member (enforces `max_users`) |

## Workspaces

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/organizations/:orgId/workspaces` | viewer | List workspaces |
| POST | `/api/organizations/:orgId/workspaces` | admin | Create (enforces `max_workspaces`) |
| GET | `/api/workspaces/:id` | viewer | Get one |

## Pages & blocks

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/workspaces/:workspaceId/pages` | viewer | Page tree (flat + `parent_id`) |
| POST | `/api/workspaces/:workspaceId/pages` | editor | Create page (optional `parent_id`) |
| GET | `/api/pages/:id` | viewer | Page + its blocks |
| PATCH | `/api/pages/:id` | editor | Update title/icon |
| DELETE | `/api/pages/:id` | editor | Archive (soft-delete) |
| POST | `/api/pages/:pageId/blocks` | editor | Create block |
| PATCH | `/api/blocks/:id` | editor | Update block content/position |
| DELETE | `/api/blocks/:id` | editor | Delete block |

**Block types:** `heading, paragraph, image, file, table, database, kanban,
checklist, code, quote, divider, embed, child_page`.

## Search

| Method | Path | Description |
|---|---|---|
| GET | `/api/search?q=...` | Postgres full-text search across pages the caller can read |

## Groups (departments / teams)

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/organizations/:orgId/groups` | viewer | List groups + member counts |
| POST | `/api/organizations/:orgId/groups` | admin | Create group (`name, color, icon, description`) |
| POST | `/api/groups/:id/members` | admin | Add a user to a group |
| DELETE | `/api/groups/:id/members/:userId` | admin | Remove a user |
| POST | `/api/groups/:id/grants` | admin | Grant the group a role on a `workspace`/`organization` |

## Invitations (email or shareable link)

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/organizations/:orgId/invitations` | admin | Create invite; emails a link when `email` set, else returns a shareable link |
| GET | `/api/invitations/:token` | public | Invite context for the accept screen |
| POST | `/api/invitations/accept` | authed | Redeem a token → join org (+ workspace/group) |
| POST | `/api/invitations/:id/revoke` | admin | Revoke |

## Databases & project management

| Method | Path | Min role | Description |
|---|---|---|---|
| GET/POST | `/api/workspaces/:workspaceId/databases` | viewer/editor | List / create a database |
| GET | `/api/databases/:id` | viewer | Database + properties + views |
| POST | `/api/databases/:id/properties` | editor | Add a typed property (select options carry `color`) |
| POST | `/api/databases/:id/views` | editor | Add a view (`table/board/calendar/gallery/list/timeline`) |
| GET/POST | `/api/databases/:id/records` | viewer/editor | List / create records |
| PATCH/DELETE | `/api/records/:id` | editor | Update (JSONB merge) / delete a record |
| GET | `/api/databases/:id/report?group_by=&progress=` | viewer | Statistics: counts per status (with colors) + progress rollup |

## History, versioning & audit

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/pages/:id/versions` | editor | Snapshot current page (backup/checkpoint) |
| GET | `/api/pages/:id/versions` | viewer | Version history |
| POST | `/api/pages/:id/versions/:version/restore` | editor | Restore a version (checkpoints current first) |
| GET | `/api/pages/:id/backlinks` | viewer | Pages that link here (linked references) |
| GET | `/api/organizations/:orgId/audit` | admin | Audit trail (Enterprise adds retention/export/legal hold) |

## Import / export (portable)

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/pages/:id/export` | viewer | Export a page subtree as portable JSON |
| POST | `/api/workspaces/:workspaceId/import` | editor | Import a portable JSON tree (regenerates IDs) |

## Comments, mentions & notifications

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/comments` | commenter | Comment on a `page`/`block`/`record`; `mentions[]` notify users |
| GET | `/api/comments?target_type=&target_id=` | viewer | List comments for a target |
| POST | `/api/comments/:id/resolve` | commenter | Resolve a thread |
| DELETE | `/api/comments/:id` | author/editor | Delete a comment |
| GET | `/api/notifications?unread=1` | authed | My notifications |
| GET | `/api/notifications/unread-count` | authed | Unread badge count |
| POST | `/api/notifications/:id/read` · `/read-all` | authed | Mark read |

## Publishing (public pages)

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/pages/:id/publish` | admin | Publish read-only (`slug`, `password?`, `seo`) → returns public URL |
| DELETE | `/api/pages/:id/publish` | admin | Unpublish |
| GET | `/api/public/:slug` | public | Render a published page; password via `?password=` or `x-page-password` |

## Files (attachments)

Metadata in Postgres, bytes in object storage (local / S3 / MinIO / R2).

| Method | Path | Min role | Description |
|---|---|---|---|
| POST | `/api/workspaces/:workspaceId/files` | editor | Create metadata; returns an upload target (presigned PUT on S3, else direct) |
| PUT | `/api/files/:id/content` | editor | Direct byte upload (`application/octet-stream`) |
| GET | `/api/files/:id` | viewer | Metadata + download URL |
| GET | `/api/files/:id/content` | viewer | Stream bytes |
| DELETE | `/api/files/:id` | editor | Delete object + metadata |

## Integrations & automation

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/integrations/providers` | public | Supported providers (webhook/slack/discord/teams/github/gitlab) |
| GET/POST | `/api/workspaces/:workspaceId/integrations` | viewer/admin | List (no secrets) / create an integration |
| DELETE | `/api/integrations/:id` | admin | Remove |
| GET/POST | `/api/workspaces/:workspaceId/automations` | viewer/admin | List / create automation (`trigger_type`, `trigger_filter`, `actions[]`) |
| PATCH/DELETE | `/api/automations/:id` | admin | Toggle/update / delete |
| GET | `/api/automations/:id/runs` | admin | Execution log |

**Triggers:** `page.created`, `record.created`, `record.updated`,
`task.completed`, `comment.added`, `invite.accepted`.
**Actions:** `webhook` (HMAC-signed `X-Kinynx-Signature`), `notification`,
`email`, `slack`/`discord`/`call_integration`. `trigger_filter` is an equality
match on the event payload; action messages support `{{data.field}}`.

## AI (pluggable provider)

Configure via `AI_PROVIDER` (`anthropic`/`openai`/`google`/`ollama`/`openrouter`/`custom`/`mock`).
Self-hosters can run local models; Enterprise can set `AI_ALLOW_EXTERNAL=false`.

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/ai/status` | public | Whether AI is enabled, provider, external policy |
| POST | `/api/ai/summarize` | page viewer | Summarize a page (`page_id`) |
| POST | `/api/ai/rewrite` | authed | Rewrite `text` per `instruction` |
| POST | `/api/ai/complete` | authed | Generic completion (`system?`, `prompt`) |

## Template marketplace

Templates are portable packages (`.template.zip` = manifest.json + content/page.json).
Browsing and downloading are **public** (no paid account); publishing needs auth.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/templates` | authed | Publish a template from a page subtree |
| GET | `/api/templates?q=&category=` | public | Search the marketplace (FTS, ranked by downloads) |
| GET | `/api/templates/categories` | public | Category list |
| GET | `/api/templates/:id` | public | Metadata + avg rating + downloads |
| GET | `/api/templates/:id/download` | public | Portable JSON package |
| GET | `/api/templates/:id/download.zip` | public | `.template.zip` file |
| POST | `/api/templates/:id/import` | editor | Import into a workspace (`workspace_id`) |
| POST | `/api/workspaces/:workspaceId/templates/import-zip` | editor | Import an uploaded `.template.zip` (octet-stream) |
| POST | `/api/templates/:id/rate` | authed | Rate 1–5 |

## Billing

| Method | Path | Min role | Description |
|---|---|---|---|
| GET | `/api/billing/plans` | public | Plan catalog (limits + features) from central entitlements |
| GET | `/api/organizations/:orgId/billing` | viewer | Current plan |
| POST | `/api/organizations/:orgId/billing/checkout` | owner | Start checkout (Stripe redirect or manual instructions) |

Provider is pluggable (`BILLING_PROVIDER=manual|stripe`); business logic never
calls Stripe directly.

## Admin console (deployment admin)

Admin = `ADMIN_EMAILS` allowlist, or any org owner when unset (self-host).

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/stats` | Users/orgs/workspaces/pages/files/storage counts + edition |
| GET | `/api/admin/health` | DB/storage/realtime/search health, storage driver, AI |
| GET | `/api/admin/license` | Current edition, features, limits |
| POST | `/api/admin/license` | Upload a signed license → activates the edition at runtime |

## OpenAPI

`GET /api/openapi.json` (OpenAPI 3.1) · `GET /api/docs` (Redoc viewer).

## Realtime (WebSocket)

```
WS /api/realtime?workspaceId=<uuid>&token=<access token>
```

Server → client events: `presence` (who is viewing/editing), `page.updated`,
`page.version`, `block.created|updated|deleted`. Client → server: `{ type:
"presence", pageId, state: "viewing"|"editing" }`. REST mutations also broadcast,
so all clients live-sync without polling. Permission to read the workspace is
enforced on connect.

## Planned (later phases)

```
GET/POST         /api/templates                # marketplace (Phase 4)
POST             /api/pages/:id/publish        # publishing (Phase 4)
GET/POST         /api/integrations             # integration framework (Phase 6)
POST             /api/ai/summarize             # AI abstraction (Phase 7)
```

## Example

```bash
TOKEN=$(curl -s -X POST localhost/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@acme.com","password":"supersecret1"}' | jq -r .access_token)

ORG=$(curl -s -X POST localhost/api/organizations -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Acme"}' | jq -r .organization.id)

curl -s -X POST localhost/api/organizations/$ORG/workspaces -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Engineering"}'
```
