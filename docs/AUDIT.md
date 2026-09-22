# Gap Audit — spec vs. implementation

Status of every requirement from the product brief. ✅ done · 🟡 partial · ⛔ not yet.
Updated as the build progresses.

| # | Area | Status | Notes |
|---|---|---|---|
| 1 | Three-tier business model | ✅ | `packages/shared` entitlements (community/team/enterprise) |
| 2 | Configurable Team limits | ✅ | Limits are data, not hard-coded; license can override |
| 3 | Enterprise features | 🟡 | LDAP/Authentik sync ✅, audit read ✅; SAML/OIDC session, custom roles, IP allowlist, MFA policies ⛔ |
| 4 | Core/Enterprise license split | ✅ | Apache-2.0 core; `/enterprise` commercial; no core→enterprise imports |
| 5 | Block-based editor (data model) | ✅ | First-class `blocks`; rich editor UI is minimal (reference client) |
| 6 | Database system | 🟡 | Properties, records, report, default view ✅; board/calendar/timeline rendering, formulas, rollups ⛔ |
| 7 | Collaboration | ✅ | Realtime presence + live sync, history/versioning ✅; **comments/mentions/notifications ✅**; live cursors, CRDT ⛔ |
| 8 | Permissions (server-side) | ✅ | Enforced server-side + group grants; custom roles ⛔ (enterprise) |
| 9 | Template system | 🟡 | Portable JSON export/import ✅; `.template.zip` packaging, fork/version ⛔ |
| 10 | Template marketplace | ⛔ | Planned (Phase 4) |
| 11 | Publishing (public pages) | ✅ | Public read-only pages by slug, SEO metadata, optional password |
| 12 | Search | ✅ | Postgres FTS; Meilisearch/OpenSearch pluggable later |
| 13 | File storage (metadata in PG, bytes in object store) | ✅ | StorageDriver (local + S3/MinIO/R2); files API; bytes never in PG |
| 14 | Authentication | 🟡 | email/password ✅; LDAP/Authentik sync ✅; magic link, OAuth, SAML/OIDC login ⛔ |
| 15 | API + OpenAPI | ✅ | REST for all core resources; `/api/openapi.json` served |
| 16 | Integrations framework | ✅ | Provider registry (webhook/slack/discord/teams/github/gitlab); actions call integrations; secrets never returned |
| 17 | Automation engine | ✅ | WHEN trigger [+ filter] THEN actions; webhook (HMAC-signed)/notification/email/integration; run log |
| 18 | AI provider abstraction | ⛔ | Planned (Phase 7) |
| 19 | Self-hosting (Docker) | ✅ | `docker compose up -d`; air-gap friendly |
| 20 | One codebase → 3 deployments | ✅ | Same core; edition via entitlements |
| 21 | Multi-tenancy | ✅ | User→Org→Workspace; a user in many orgs |
| 22 | Billing abstraction | 🟡 | Documented; `BillingProvider` code ⛔ |
| 23 | Enterprise license upload | 🟡 | Offline verification ✅; upload endpoint ⛔ |
| 24 | Admin console | 🟡 | `/health` + `/api/system/info`; full admin UI ⛔ |
| 25 | Developer docs | ✅ | README + ARCHITECTURE + 8 docs |
| 26 | Technology | ✅ | Documented adaptation (TS API over raw PG) |
| 27 | Monorepo structure | ✅ | apps/packages/services/enterprise/infrastructure/docs |
| 28 | Phased, always-runnable build | ✅ | Phase 1–2 done, 3 core done |
| 29 | Product philosophy | ✅ | Open, portable, API-first |
| 30 | First-deliverable checklist | ✅ | Arch, schema, API, permissions, template spec, licensing, Docker, auth, editor slice |

## Next up (priority order)
1. Realtime **Redis fan-out** ✅ · **LDAP/Authentik sync** ✅
2. **Comments / mentions / notifications** ✅
3. **File storage** (local + S3/MinIO) ✅
4. **Publishing** public pages ✅
5. **OpenAPI** document ✅
6. **Integrations framework + webhooks** ✅ · **Automation engine** ✅
7. AI provider abstraction (OpenAI/Anthropic/Ollama/custom) — next
8. Template `.template.zip` packaging + marketplace (Phase 4)
9. Enterprise: SAML/OIDC login, custom roles, license upload endpoint, admin console
10. Billing provider abstraction (Stripe/manual)
