# Permission Model

## Principle

> Permissions are enforced **server-side**. Hiding a UI control is never a
> security mechanism.

Every mutating or reading route resolves the caller's *effective role* on the
target resource and calls `assertCan(role, action)` before doing any work. This
is proven by the integration test *"outsider cannot read another user's
workspace"* (expects HTTP 403).

## Roles

Ordered most → least privileged:

| Role | Rank | Typical abilities |
|---|---|---|
| `owner` | 40 | Everything, incl. delete org, manage billing |
| `admin` | 30 | Manage members, create/delete workspaces, publish, view audit logs |
| `editor` | 20 | Create/edit/delete pages, blocks, records |
| `commenter` | 10 | Read + comment |
| `viewer` | 0 | Read only |

Custom roles are an Enterprise capability (`advanced_permissions`) layered on
this base; the engine maps a custom role to a rank + explicit action grants.

## Scope hierarchy & effective role

```
Organization  →  Workspace  →  Page  →  Database/Record
```

Effective role is resolved by walking the chain and **escalating** to the
highest grant found (grants only raise privilege, never silently reduce it):

```
effectiveRole(orgRole, workspaceRole, pageRole)  // = highest-ranked non-null
```

- An **org admin** is automatically at least admin on every workspace in the org.
- A **workspace editor** who is only an org viewer is still an editor in that
  workspace.
- A **page-level** grant (`page_permissions`) can raise a user above their
  workspace role for a specific page (advanced permissions).

Implemented in [`services/api/src/access.ts`](../services/api/src/access.ts) and
[`packages/permissions/src/index.ts`](../packages/permissions/src/index.ts).

## Actions

Granular, explicit action strings gate each capability, e.g.:

```
org:read  org:update  org:delete  org:manage_members  org:manage_billing  org:view_audit_logs
workspace:read  workspace:create  workspace:update  workspace:delete  workspace:manage_members
page:read  page:create  page:update  page:delete  page:comment  page:share  page:publish
record:read  record:create  record:update  record:delete
```

Each action maps to a **minimum required role** in `REQUIRED`. `can()` returns
`rank(userRole) >= rank(requiredRole)`. `assertCan()` throws `ForbiddenError`
(HTTP 403), which the API's error handler shapes without leaking internals.

## Enforcement checklist for new routes

1. Authenticate (`preHandler: app.authenticate`) → sets `request.user`.
2. Resolve effective role via `orgRole` / `workspaceRole` / `pageRole`.
3. `assertCan(role, "<action>")` **before** any read/write.
4. Validate input with Zod.
5. Never trust client-supplied IDs for scope — always re-derive scope from the
   resource row.
