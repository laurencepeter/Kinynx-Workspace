# Kinynx — repository guide

Open-source, self-hostable collaborative workspace. pnpm monorepo.

## Layout
- `packages/shared` — entitlements/feature flags, license verification, roles (Apache-2.0)
- `packages/permissions` — server-side authorization matrix (`can`/`assertCan`)
- `services/api` — Fastify + PostgreSQL API (the core); `src/worker.ts` is the background worker
- `enterprise/*` — commercially-licensed modules (directory-discovery, directory-sync); **never imported by core**
- `apps/web` — reference clients: `index.html` (docs), `board.html` (Kanban), `admin.html`
- `infrastructure/docker` — Dockerfile + Caddyfile; `docker-compose.yml` at root
- `brand/` — logo, iOS/Android/web app icons, motion tokens; all generated from `brand/src/geometry.mjs` (`cd brand && npm run build`), outside the pnpm workspace
- `docs/` — ARCHITECTURE, API, DATABASE, PERMISSIONS, LICENSING, TEMPLATE_SPEC, AUDIT, …

## Commands
```bash
pnpm install
pnpm -r run build          # build packages + services
pnpm -r run typecheck
pnpm --filter @kinynx/api run migrate   # apply SQL migrations (needs DATABASE_URL)
DATABASE_URL=... REDIS_URL=... JWT_SECRET=... pnpm -r run test   # full suite
docker compose up -d       # full stack → http://localhost
```
Tests need Postgres (and Redis for the cross-node realtime test); they **skip
cleanly** when unavailable. CI runs everything in `.github/workflows/ci.yml`.

## Conventions (important)
- **Security is server-side.** Every route: authenticate → resolve effective role
  (`orgRole`/`workspaceRole`/`pageRole` in `src/access.ts`) → `assertCan(role, action)`
  → validate input with Zod → act. Hiding UI is never a boundary.
- **Entitlements are central.** Never hard-code `if (plan === 'enterprise')`; read
  `app.entitlements` (resolved from the license). Gate enterprise features on the
  relevant flag and return `402` in Community.
- TypeScript strict, ESM, NodeNext (relative imports end in `.js`). Parameterized SQL only.
- New migration: `services/api/src/migrations/NNNN_name.sql` (zero-padded, lexical order);
  the runner applies each once inside a transaction under an advisory lock.
- Provider abstractions (email, storage, AI, billing, realtime bus) live behind
  interfaces — add a driver, don't fork call sites.
- `enterprise/` may depend on core; core must never import `enterprise/`.

## Editions
Community/Team = Apache-2.0 core, genuinely useful, never crippled. Enterprise
features (SSO/SAML/LDAP/SCIM, custom roles, audit retention/legal hold, IP
allowlist, org MFA policy, admin) are gated by a signed license, verified offline.
