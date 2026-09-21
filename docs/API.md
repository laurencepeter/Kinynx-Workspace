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
| GET | `/api/auth/me` | current user |

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

## Planned (later phases)

```
GET/POST         /api/databases/:id            # database system (Phase 3)
GET/POST         /api/databases/:id/records
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
