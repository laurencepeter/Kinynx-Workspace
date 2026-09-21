# Deployment

Kinynx is designed to self-host with a single command and to run **fully offline
/ air-gapped** after images are pulled.

## Docker Compose (recommended)

```bash
cp .env.example .env      # set POSTGRES_PASSWORD, JWT_SECRET, S3_SECRET_KEY, ...
docker compose up -d
```

Services: `postgres`, `redis`, `minio`, `api`, `web`, `caddy`. Caddy exposes
:80/:443 and routes `/api` + `/health` to the API and everything else to the web
client. Open **http://localhost**.

Generate secrets:

```bash
openssl rand -base64 48   # JWT_SECRET
```

### Health & migrations

The API applies migrations on boot and serves `/health` (checks API + database).
Compose healthchecks gate `api` on Postgres/Redis being ready.

## Reverse proxy / TLS

For a public domain, edit `infrastructure/docker/Caddyfile` and replace `:80`
with your hostname — Caddy provisions certificates automatically. Traefik works
equally well; point it at `api:4000` for `/api` and `/health`.

## Object storage

Default is MinIO (S3-compatible). Point at AWS S3 or Cloudflare R2 by setting
`STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, and keys. File
bytes never touch Postgres.

## Coolify

Import the repo, use `docker-compose.yml` as the stack, set the `.env` values in
Coolify's environment UI, and deploy. No changes required.

## Kubernetes

Translate the compose services to Deployments/StatefulSets (Postgres + MinIO as
StatefulSets with PVCs; API/web as Deployments; an Ingress in place of Caddy).
Manifests live under `infrastructure/kubernetes/` (Phase 5+). The API is
stateless and horizontally scalable; sessions are JWT-based.

## Air-gapped / private networks

1. Pull images on a connected host and `docker save` them.
2. Transfer and `docker load` on the target.
3. `docker compose up -d`.

No outbound internet is required at runtime. License verification is **offline**
(Ed25519) — there is no phone-home. AI features are optional and only reach out
if you configure an external `AI_PROVIDER` (use Ollama for fully local models).

## Enterprise license (self-hosted)

```bash
KINYNX_LICENSE_FILE=/etc/kinynx/kinynx.license
KINYNX_LICENSE_PUBLIC_KEY=<base64 Ed25519 SPKI DER>
```

Mount the license file into the `api` container. If it is missing/invalid, the
deployment simply runs as Community Edition. See [LICENSING](LICENSING.md).

## Backups

- **Postgres**: `pg_dump` on a schedule (Enterprise adds automated backup
  policies).
- **Object storage**: bucket replication or `mc mirror`.
- Restore = load the dump, restore the bucket, `docker compose up -d`.
