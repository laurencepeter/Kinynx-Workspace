# Kinynx on Coolify

[Coolify](https://coolify.io) deploys Kinynx straight from the repo's
`docker-compose.yml` — no extra config files needed.

## Steps

1. **New Resource → Docker Compose** and point it at this repository
   (Coolify reads the root `docker-compose.yml`).
2. **Environment variables** (Coolify UI) — set at least:
   - `POSTGRES_PASSWORD`, `JWT_SECRET` (`openssl rand -base64 48`), `S3_SECRET_KEY`
   - `PUBLIC_APP_URL` = your Coolify-assigned domain (e.g. `https://kinynx.yourdomain.com`)
   - Storage: leave `STORAGE_DRIVER` unset for `local` (default, `uploads`
     volume), or set `STORAGE_DRIVER=s3` + `S3_*` for external S3/R2
   - Email (`EMAIL_DRIVER=smtp`, `SMTP_*`) and SSO/AI vars as needed
3. **Deploy.** Coolify builds the API/worker images and starts Postgres, Redis,
   API, worker, web, and Caddy. The API runs migrations on boot.
4. **Domain & TLS.** Assign a domain in Coolify; it terminates TLS in front of
   the stack. (You can drop the bundled `caddy` service and let Coolify's proxy
   handle routing, or keep Caddy and expose only it.)

## Notes

- Persistent volumes (`pgdata`, `redisdata`, `uploads`) are declared in the
  compose file and managed by Coolify.
- MinIO is **not** in the root compose file: Coolify pulls every service it
  lists (ignoring `profiles`), and anonymous pulls of MinIO images now fail
  (`401 UNAUTHORIZED` from quay.io). Use external S3/R2, or a separate MinIO
  resource with an image you can authenticate to, and point `S3_ENDPOINT` at it.
- For Enterprise, mount a license file and set `KINYNX_LICENSE_FILE` +
  `KINYNX_LICENSE_PUBLIC_KEY`, or upload it at runtime via the admin console.
