# Licensing & Feature System

Kinynx separates **open-source core** from **commercial enterprise** cleanly, and
resolves every capability through one central system so the Community Edition can
never be accidentally crippled.

## Code licensing (what is open vs. commercial)

| Path | License | Notes |
|---|---|---|
| `apps/` | Apache-2.0 | Web/desktop/mobile/admin clients |
| `packages/` | Apache-2.0 | Editor, permissions, shared licensing logic |
| `services/` | Apache-2.0 | API, worker, realtime, marketplace |
| `infrastructure/` | Apache-2.0 | Docker, k8s, reverse proxy |
| `enterprise/` | **LicenseRef-Kinynx-Enterprise** (commercial) | SSO/LDAP/SCIM, audit, advanced RBAC, directory auto-discovery |

You can clone, self-host, modify, and redistribute the entire core under
Apache-2.0 with **no** artificial restriction. The `enterprise/` tree is not
needed to run the Community Edition; it is separately licensed.

## Runtime entitlements (what a deployment can do)

Defined once in [`packages/shared/src/features.ts`](../packages/shared/src/features.ts):

- `Plan` — `community | team | enterprise`
- `FeatureFlags` — booleans (e.g. `sso_saml`, `audit_logs`, `advanced_permissions`)
- `Limits` — `max_users`, `max_workspaces`, `max_storage_bytes`, `max_file_size_bytes`
  (`UNLIMITED = -1`)

**Rule:** no route hard-codes `if (plan === 'enterprise')`. Everything reads
`app.entitlements`. This keeps limits configurable and the core uncrippled.

### The `FeatureFlags` surface

```
FeatureFlags
├── (core, always on) documents, databases, kanban, tables, tasks, comments,
│                     collaboration, file_attachments, templates,
│                     template_marketplace, publishing, search, api,
│                     integrations_basic
└── (gated)           advanced_permissions, audit_logs, sso_saml, sso_oidc,
                      ldap, scim, directory_autodiscovery, retention_policies,
                      legal_hold, ip_allowlist, mfa_policies, advanced_security,
                      custom_domains, organization_admin, advanced_automation,
                      priority_support
```

## Enterprise license files (self-hosted)

A license is an **Ed25519-signed JSON** file an org uploads. It is verified
**offline** — there is no phone-home.

```json
{
  "payload": {
    "license_id": "LIC-001",
    "organization_id": "org-acme",
    "plan": "enterprise",
    "issued_at": "2026-01-01T00:00:00Z",
    "expires_at": "2027-01-01T00:00:00Z",
    "user_limit": 500,
    "feature_flags": { "scim": true },
    "limits": { "max_storage_bytes": -1 }
  },
  "signature": "<base64 ed25519 over canonical JSON of payload>"
}
```

Configure:

```bash
KINYNX_LICENSE_FILE=/etc/kinynx/kinynx.license
KINYNX_LICENSE_PUBLIC_KEY=<base64 SPKI DER Ed25519 public key>
```

### Guarantees

- **Invalid / expired / missing / unverifiable → Community Edition**, never
  disabled. Verified by test *"invalid/absent license degrades to Community"*.
- **Tamper-evident.** Any change to the payload invalidates the signature.
- **Overrides.** A valid license may raise/lower limits and toggle flags on top
  of plan defaults (for negotiated deals) — see `entitlementsFor()`.

The running edition is exposed at `GET /api/system/info` and drives the UI
badge (Community vs Enterprise).

## Billing abstraction

Billing is **not** hard-coded to Stripe. A `BillingProvider` interface (Phase 6)
supports Stripe, future providers, and manual enterprise licensing. License
checks always go through the central entitlement service above — billing state
feeds it, it does not bypass it.
