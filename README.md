<div align="center">

# ◆ Kinynx

**An open-source, self-hostable collaborative workspace.**
Documents · Wikis · Databases · Kanban · Tasks · Templates · Collaboration

*Genuinely useful for free. Enterprise pays for scale, security, and compliance — never for the basic ability to create documents.*

[Architecture](ARCHITECTURE.md) · [API](docs/API.md) · [Database](docs/DATABASE.md) · [Permissions](docs/PERMISSIONS.md) · [Licensing](docs/LICENSING.md) · [Templates](docs/TEMPLATE_SPEC.md) · [Deploy](docs/DEPLOYMENT.md) · [Security](SECURITY.md)

</div>

---

## Quick start (self-hosting)

```bash
git clone <this-repo> kinynx && cd kinynx
cp .env.example .env          # then edit secrets
docker compose up -d
```

Open **http://localhost**. That's it — Postgres, Redis, object storage (MinIO),
the API, the web client, and a Caddy reverse proxy all come up together. The
API applies database migrations automatically on boot. Works fully offline /
air-gapped once images are pulled.

## Local development

```bash
pnpm install
pnpm --filter @kinynx/shared --filter @kinynx/permissions run build
pnpm --filter @kinynx/api run migrate     # needs a running Postgres (DATABASE_URL)
pnpm --filter @kinynx/api run dev          # API on :4000, hot reload
```

Run the tests (pure logic runs anywhere; integration tests need Postgres and
skip cleanly without it):

```bash
pnpm test
```

## Editions

| | **Community** | **Team** | **Enterprise** |
|---|---|---|---|
| Price | Free, self-hosted | Free tier | Commercial |
| Docs, databases, kanban, tables, tasks | ✅ | ✅ | ✅ |
| Comments, collaboration, files, search | ✅ | ✅ | ✅ |
| Templates + marketplace, publishing, API | ✅ | ✅ | ✅ |
| Users | Unlimited | 10 (configurable) | Unlimited |
| Advanced permissions / custom roles | — | ✅ | ✅ |
| SSO (SAML/OIDC), LDAP, SCIM, auto-discovery | — | — | ✅ |
| Audit logs, retention, legal hold, IP allowlist | — | — | ✅ |
| Org administration, advanced automation | — | ✅ (admin) | ✅ |

The Community Edition is **never** crippled to force upgrades, and it keeps
working even if a license server is unreachable. See [LICENSING](docs/LICENSING.md).

## What's in the box

**Phase 1 — Foundation**
- ✅ Email/password auth (Argon2id), JWT access + rotating refresh tokens
- ✅ Multi-tenancy: User → Organization → Workspace → Page → Block
- ✅ Block-based editor data model (first-class blocks, not JSON blobs)
- ✅ **Server-side** permission enforcement (Owner/Admin/Editor/Commenter/Viewer)
- ✅ Central feature-flag / licensing system with offline Ed25519 verification
- ✅ Postgres full-text search
- ✅ Docker Compose deployment (Postgres, Redis, MinIO, Caddy)

**Phase 2 — Collaboration & project management**
- ✅ **Realtime** presence + live-sync over WebSocket ("who's viewing/editing"),
  REST mutations broadcast too — no polling
- ✅ **Groups** (departments/teams) with role grants on workspaces/orgs; the
  basis for LDAP/Authentik group sync
- ✅ **Invitations** by email or shareable link (accept → join org/workspace/group)
- ✅ **Email provider abstraction** — console, SMTP (Mailjet/SendGrid/SES/Postmark/…),
  or Mailjet REST; swap by env var
- ✅ **Project databases**: typed properties, **status with color coding**,
  progress, views, and a **/report** endpoint (counts per status + rollups)
- ✅ **Versioning & history**: page snapshots, restore (reversible), audit trail
- ✅ **Page linking & backlinks**, workspace/page/group **color coding & icons**
- ✅ **Import / export** of page trees as portable JSON (template foundation)

**Foundations for later phases**
- ✅ Flexible database schema (typed properties, records, views, relations)
- ✅ Enterprise SSO/directory **auto-discovery** module (domain → recommended IdP)
- 📄 Specs for the template package format, API, permissions, licensing

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full roadmap (Phases 3–7) and
[docs/API.md](docs/API.md) for every endpoint.

## Repository layout

```
apps/          web (demo client), admin (planned)
packages/      shared (features/licensing/roles), permissions
services/      api (Fastify + Postgres)
enterprise/    commercially-licensed modules (directory-discovery, …)
infrastructure/docker (Dockerfile, Caddyfile)
docs/          architecture & specifications
```

## Licensing at a glance

- **`/apps`, `/packages`, `/services`, `/infrastructure`** — Apache-2.0 ([LICENSE](LICENSE)).
- **`/enterprise`** — commercial ([enterprise/LICENSE](enterprise/LICENSE)). Not
  required to self-host the Community Edition.

## License

Apache-2.0 for the core. See [LICENSING](docs/LICENSING.md) for the full split.
