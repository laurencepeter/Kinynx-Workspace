# Kinynx on Kubernetes

`kinynx.yaml` deploys the whole stack (Postgres StatefulSet, Redis, MinIO, API x2,
worker, web x2, Ingress) into a `kinynx` namespace. The API applies migrations on
boot, so no separate migration Job is required.

## 1. Build & push images

```bash
docker build -t <registry>/kinynx/api:latest -f infrastructure/docker/api.Dockerfile .
docker build -t <registry>/kinynx/web:latest -f infrastructure/docker/web.Dockerfile .
docker push <registry>/kinynx/api:latest
docker push <registry>/kinynx/web:latest
```

Then update the `image:` fields in `kinynx.yaml` (`kinynx/api:latest`,
`kinynx/web:latest`) to your registry paths.

## 2. Secrets & config

Edit the `Secret` (`POSTGRES_PASSWORD`, `JWT_SECRET`, `S3_SECRET_KEY`) and the
`ConfigMap` (`PUBLIC_APP_URL`, the Ingress `host`). Generate a JWT secret with
`openssl rand -base64 48`.

## 3. Apply

```bash
kubectl apply -f kinynx.yaml
kubectl -n kinynx get pods
```

Point DNS at your ingress controller for the configured host. The Ingress routes
`/api` + `/health` to the API and everything else to the web client; the
`proxy-read-timeout` annotation keeps WebSocket realtime connections open.

## Scaling & HA

- The API is stateless (JWT sessions) — scale `api` replicas freely; realtime
  fan-out uses Redis so presence/live-sync work across replicas.
- Run a single `worker` replica (its jobs are idempotent, but one is enough).
- For production Postgres/MinIO, prefer an operator or managed service over the
  single-replica manifests here.
