# Development

## Prerequisites

- Node.js ≥ 20 (22 recommended)
- pnpm ≥ 10 (`corepack enable`)
- PostgreSQL 16 (local, Docker, or the compose stack)

## Setup

```bash
pnpm install
# Native module argon2 needs to build once; it is pre-approved in package.json
# (pnpm.onlyBuiltDependencies). If it didn't build: pnpm --filter @kinynx/api rebuild argon2

pnpm --filter @kinynx/shared --filter @kinynx/permissions run build
```

## Running the API locally

```bash
export DATABASE_URL=postgres://kinynx:kinynx@localhost:5432/kinynx
export JWT_SECRET=$(openssl rand -base64 48)

pnpm --filter @kinynx/api run migrate   # apply schema
pnpm --filter @kinynx/api run dev        # http://localhost:4000  (tsx watch)
```

The web reference client is static — serve `apps/web` with any static server, or
just use the full `docker compose up -d` stack (recommended).

Text blocks are edited with [Tiptap](https://tiptap.dev) v3 (ProseMirror, MIT),
bundled by `apps/web-editor` into `apps/web/vendor/kinynx-tiptap.js` (git-ignored;
no CDN, so the CSP stays `script-src 'self'`). Build it once before serving
`apps/web` yourself:

```bash
pnpm --filter @kinynx/web-editor run build   # or: pnpm -r run build
```

The Docker web image builds it automatically. Without the bundle, text blocks
fall back to plain-text editing.

## Monorepo scripts (root)

| Command | Effect |
|---|---|
| `pnpm build` | Build packages + services |
| `pnpm typecheck` | Type-check every workspace project |
| `pnpm test` | Run all test suites |
| `pnpm dev` | Run the API in watch mode |
| `pnpm migrate` | Apply migrations |

## Tests

- **Pure logic** (`packages/*`, permissions, licensing, discovery) runs with no
  external services.
- **API integration** (`services/api/test/api.test.ts`) needs Postgres. It
  probes `DATABASE_URL` at load and **skips cleanly** if unreachable, so the
  suite stays green on machines without a DB.

```bash
# with a DB:
DATABASE_URL=postgres://kinynx:kinynx@localhost:5432/kinynx_test pnpm test
```

## Conventions

- TypeScript strict mode, ESM, NodeNext resolution (relative imports use `.js`).
- Validate all external input with Zod at the route boundary.
- New routes: authenticate → resolve effective role → `assertCan` → validate →
  act. See [PERMISSIONS](PERMISSIONS.md).
- Never read entitlements by hard-coding a plan; read `app.entitlements`.
- Keep `enterprise/` code out of the Apache-2.0 import graph of the core.

## Adding a migration

Create `services/api/src/migrations/NNNN_name.sql` (zero-padded, lexical order).
The runner applies new files once each inside a transaction and records them in
`schema_migrations`. The build copies migrations into `dist/` for the container.
