# Contributing to Kinynx

Thanks for helping build an open workspace platform. The core is Apache-2.0 and
we want it to stay genuinely useful for everyone.

## Ground rules

- **Keep the Community Edition uncrippled.** Core features never get gated to
  push upgrades. Gate only organizational-scale/compliance features, through the
  central entitlement system (`packages/shared`), never inline `if (plan === ...)`.
- **Security is server-side.** New endpoints must enforce permissions in the
  API. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md).
- **Keep it runnable.** Every PR should leave `docker compose up -d` working.

## Workflow

1. Fork and branch from `main`.
2. `pnpm install`, build packages, make your change.
3. Add/adjust tests. Run `pnpm typecheck` and `pnpm test`.
4. Follow the conventions in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
5. Open a PR describing the change and its edition impact (core vs enterprise).

## Where things go

- Core, open-source code → `apps/`, `packages/`, `services/`, `infrastructure/`
  (Apache-2.0).
- Commercial/enterprise code → `enterprise/` (separate license). Do not import
  `enterprise/` from the core.

## Code style

- TypeScript strict, ESM, NodeNext. Prefer small, well-named modules.
- Validate external input at the boundary (Zod).
- Parameterized SQL only.

## DCO / licensing of contributions

By contributing to a directory, you agree your contribution is licensed under
that directory's license (Apache-2.0 for core; the commercial license for
`enterprise/`). Sign off commits with `git commit -s` (Developer Certificate of
Origin).

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please report privately, not via public issues.
