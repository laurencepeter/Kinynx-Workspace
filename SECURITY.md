# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **security@kinynx.dev**
(placeholder — replace with your project's contact). Do not open public issues
for security reports. We aim to acknowledge within 3 business days and to
coordinate a fix and disclosure timeline with you.

## Supported versions

During pre-1.0 development, only the latest `main` is supported for security
fixes.

## Security design

Authorization and secrets handling are enforced in the backend; the UI is never
a trust boundary.

- **Passwords**: Argon2id (memory 19 MiB, time cost 2), via the `argon2` native
  module. Login runs a verify even for unknown users to blunt user-enumeration
  timing.
- **Sessions**: short-lived HS256 JWT access tokens (15 min default) + opaque
  refresh tokens. Only a **SHA-256 hash** of each refresh token is stored;
  refresh **rotates** (old token revoked, new issued) and checks expiry +
  revocation.
- **Authorization**: every route resolves the caller's effective role across the
  Org→Workspace→Page chain and calls `assertCan()` before acting. Enforced
  server-side; covered by tests. See [PERMISSIONS](docs/PERMISSIONS.md).
- **Input validation**: all request bodies/params/queries validated with Zod;
  parameterized SQL everywhere (no string-built queries).
- **HTTP hardening**: Helmet security headers, CORS pinned to `PUBLIC_APP_URL`,
  a global 300 req/min/IP limit, and **tighter per-route limits on credential
  endpoints** (login 20/min, register 30/min, magic-link 10/min, MFA 10/min) to
  blunt brute-force.
- **MFA**: optional per-user TOTP (RFC 6238); an org can require it fleet-wide.
- **Org security policies**: IPv4 allowlist and required-MFA, enforced at
  authentication (Enterprise `advanced_security`).
- **Compliance**: retention policies with legal-hold suspension of deletion.
- **Error handling**: a central handler avoids leaking internals; 5xx are logged
  server-side, clients get a generic message.
- **Licensing**: Ed25519 signature verification is **offline**; there is no
  phone-home, and tampering invalidates the license. A bad/absent license
  degrades to Community, never a lockout.
- **Data at rest**: file bytes live in object storage, not Postgres; the schema
  is RLS-ready for tenant isolation defense-in-depth.
- **Secrets**: never committed; `.env` is git-ignored and `.env.example`
  ships only placeholders.

## Hardening checklist for operators

- [ ] Set a strong `JWT_SECRET` (`openssl rand -base64 48`) and rotate on
      suspected compromise.
- [ ] Change all default passwords in `.env` before exposing the deployment.
- [ ] Terminate TLS at Caddy/Traefik; do not expose the API directly.
- [ ] Restrict object-storage credentials to the single bucket.
- [ ] Keep Postgres on a private network; take regular backups.
- [ ] (Enterprise) enable audit logs, IP allowlist, and MFA policies.
