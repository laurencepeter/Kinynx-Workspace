/**
 * Server-side authorization.
 *
 * SECURITY: This is the ONLY source of truth for who can do what. The UI may
 * hide controls for UX, but every mutating/reading API route MUST call `can()`
 * (or a wrapper) with the caller's *effective* role on the target resource.
 * Hiding a button is never a security boundary.
 *
 * Effective role resolution (most-specific wins, then inherit downward):
 *   Organization role → Workspace role → Page role
 * A more privileged role at a broader scope is inherited unless a narrower
 * scope grants a *higher* role (grants only escalate, never silently reduce).
 */

import { ROLE_RANK, type Role } from "@kinynx/shared";

/** Every capability the system can authorize. Keep granular & explicit. */
export type Action =
  // organization
  | "org:read"
  | "org:update"
  | "org:delete"
  | "org:manage_members"
  | "org:manage_billing"
  | "org:view_audit_logs"
  // workspace
  | "workspace:read"
  | "workspace:create"
  | "workspace:update"
  | "workspace:delete"
  | "workspace:manage_members"
  // page
  | "page:read"
  | "page:create"
  | "page:update"
  | "page:delete"
  | "page:comment"
  | "page:share"
  | "page:publish"
  // database records
  | "record:read"
  | "record:create"
  | "record:update"
  | "record:delete";

/** Minimum role required for each action. */
const REQUIRED: Record<Action, Role> = {
  "org:read": "viewer",
  "org:update": "admin",
  "org:delete": "owner",
  "org:manage_members": "admin",
  "org:manage_billing": "owner",
  "org:view_audit_logs": "admin",

  "workspace:read": "viewer",
  "workspace:create": "admin",
  "workspace:update": "admin",
  "workspace:delete": "admin",
  "workspace:manage_members": "admin",

  "page:read": "viewer",
  "page:create": "editor",
  "page:update": "editor",
  "page:delete": "editor",
  "page:comment": "commenter",
  "page:share": "editor",
  "page:publish": "admin",

  "record:read": "viewer",
  "record:create": "editor",
  "record:update": "editor",
  "record:delete": "editor",
};

/**
 * Combine roles from the scope chain into a single effective role.
 * Roles only escalate: the highest-ranked grant along the chain wins.
 */
export function effectiveRole(...grants: Array<Role | null | undefined>): Role | null {
  let best: Role | null = null;
  for (const g of grants) {
    if (!g) continue;
    if (best === null || ROLE_RANK[g] > ROLE_RANK[best]) best = g;
  }
  return best;
}

/** Core authorization check. */
export function can(role: Role | null, action: Action): boolean {
  if (role === null) return false;
  return ROLE_RANK[role] >= ROLE_RANK[REQUIRED[action]];
}

/** Throwing variant for route handlers. */
export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(action: Action) {
    super(`forbidden: missing permission for ${action}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(role: Role | null, action: Action): void {
  if (!can(role, action)) throw new ForbiddenError(action);
}
