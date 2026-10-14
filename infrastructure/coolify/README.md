# Kinynx on Coolify

[Coolify](https://coolify.io) deploys Kinynx straight from the repo's
`docker-compose.yml` — no extra config files needed.

## Steps

1. **New Resource → Docker Compose** and point it at this repository
   (Coolify reads the root `docker-compose.yml`).
2. **Environment variables** (Coolify UI) — set at least:
   - `POSTGRES_PASSWORD`, `JWT_SECRET` (`openssl rand -base64 48`), `S3_SECRET_KEY`
   - `PUBLIC_APP_URL` = your Coolify-assigned domain (e.g. `https://kinynx.yourdomain.com`)
   - `STORAGE_DRIVER=minio` (default) and, if using external S3/R2, the `S3_*` vars
   - Email (`EMAIL_DRIVER=smtp`, `SMTP_*`) and SSO/AI vars as needed
3. **Deploy.** Coolify builds the API/worker images and starts Postgres, Redis,
   MinIO, API, worker, web, and Caddy. The API runs migrations on boot.
4. **Domain & TLS.** Assign a domain in Coolify; it terminates TLS in front of
   the stack. (You can drop the bundled `caddy` service and let Coolify's proxy
   handle routing, or keep Caddy and expose only it.)

## Notes

- Persistent volumes (`pgdata`, `miniodata`, `redisdata`) are declared in the
  compose file and managed by Coolify.
- For Enterprise, mount a license file and set `KINYNX_LICENSE_FILE` +
  `KINYNX_LICENSE_PUBLIC_KEY`, or upload it at runtime via the admin console.
