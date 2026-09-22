# Kinynx Enterprise

> ⚠️ **Separately licensed.** Code in this directory is under the commercial
> [Kinynx Enterprise License](LICENSE), **not** Apache-2.0. It is not required to
> self-host the Community Edition.

Enterprise modules add organizational scale, security, administration, and
compliance on top of the open core. They are activated by a valid license (see
[docs/LICENSING.md](../docs/LICENSING.md)) and must not be imported by the core.

## Modules

| Module | Status | Purpose |
|---|---|---|
| `directory-discovery/` | ✅ implemented | SSO/directory **auto-discovery**: map a sign-in email domain to a recommended identity provider and settings for IT to confirm; supports desktop auto sign-in on domain-joined devices. |
| `directory-sync/` | ✅ implemented | **LDAP / Active Directory / Authentik** user & group **sync** (provisioning + deprovisioning). Normalizes any directory into a snapshot, then reconciles Kinynx groups & memberships idempotently. |
| `sso/` | planned | SAML / OIDC connectors, session issuance |
| `scim/` | planned | SCIM push endpoint (this module already models the pull/reconcile side) |
| `audit/` | planned | Audit log reads, retention, export, legal hold |
| `rbac/` | planned | Custom roles, fine-grained ACLs |
| `admin/` | planned | Organization administration console |

## SSO / directory auto-discovery

`directory-discovery` answers the operator ask:

> When users sign in with their domain accounts, opening the app should sign them
> into their respective accounts automatically in a workspace environment, and it
> should auto-detect and recommend settings unless IT configures otherwise.

How it works (see `directory-discovery/src/index.ts`):

1. **Configured connection wins.** If an admin already set up SSO for the domain,
   use it (auto sign-in).
2. **Managed/domain-joined device** (a reverse-proxy Kerberos/SPNEGO hint) →
   recommend **Desktop SSO** so opening Kinynx signs the user in automatically.
3. **Provider heuristics** from the email domain's MX / OIDC discovery
   (Microsoft Entra ID, Google Workspace, generic OIDC) → recommend OIDC/SAML
   settings.

Recommendations are **proposals**: they never silently trust a domain or
auto-provision. An IT admin confirms or overrides. When nothing is detected, the
user falls back to email/password and IT can configure SSO manually. The module
is pure/deterministic (probe results are injected), so it is fully unit-tested.

## Directory sync (LDAP / Active Directory / Authentik)

Once an admin confirms a directory (or IT configures one directly),
`directory-sync` keeps Kinynx users, groups, and memberships in step with it:

```
DirectoryProvider.fetchSnapshot()   →   DirectorySnapshot   →   applyDirectorySync(pool, orgId, snapshot)
  (LdapDirectory / AuthentikDirectory)   (normalized users,       (idempotent upsert of users, groups
                                          groups, memberships)      by source+external_id, and member
                                                                    reconciliation → provision/deprovision)
```

- **Providers**: `LdapDirectory` (OpenLDAP / Active Directory / FreeIPA via
  `ldapts`, configurable attributes) and `AuthentikDirectory` (Authentik REST
  API; the same shape fits any OIDC/SCIM-style directory).
- **Reconciliation is pure and unit-tested**; the applier is transactional and
  **idempotent** — run it on a schedule or from a SCIM webhook and the DB
  converges. Members removed upstream are removed here (deprovisioning), and
  every run writes a `directory.sync` audit event.
- Groups synced this way carry `source` + `external_id`, so admins can grant a
  synced group a role on a workspace (see core `POST /api/groups/:id/grants`)
  and the whole team gets access — "invite by group", driven by the directory.

Wire it into an enterprise deployment from a worker:

```ts
import { AuthentikDirectory, runDirectorySync } from "@kinynx/ee-directory-sync";
const provider = new AuthentikDirectory({ baseUrl, token });
await runDirectorySync(pool, organizationId, provider, { defaultOrgRole: "viewer" });
```
