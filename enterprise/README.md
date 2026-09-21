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
| `sso/` | planned | SAML / OIDC connectors, session issuance |
| `ldap/` | planned | LDAP / Active Directory bind + sync |
| `scim/` | planned | Automatic user provisioning/deprovisioning |
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
