/**
 * Resolves a user's *effective* role on a resource by walking the scope chain
 * Organization → Workspace → Page against the database. This is the server-side
 * enforcement point; routes must call these before acting.
 */
import type pg from "pg";
import { effectiveRole } from "@kinynx/permissions";
import type { Role } from "@kinynx/shared";
import { query } from "./db/pool.js";

export async function orgRole(db: pg.Pool, userId: string, orgId: string): Promise<Role | null> {
  const rows = await query<{ role: Role }>(
    db,
    "SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    [orgId, userId],
  );
  return rows[0]?.role ?? null;
}

export async function workspaceRole(
  db: pg.Pool,
  userId: string,
  workspaceId: string,
): Promise<Role | null> {
  // Effective = max(org role for the workspace's org, explicit workspace role).
  const rows = await query<{ org_role: Role | null; ws_role: Role | null }>(
    db,
    `SELECT om.role AS org_role, wm.role AS ws_role
       FROM workspaces w
       LEFT JOIN organization_members om
         ON om.organization_id = w.organization_id AND om.user_id = $2
       LEFT JOIN workspace_members wm
         ON wm.workspace_id = w.id AND wm.user_id = $2
      WHERE w.id = $1`,
    [workspaceId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return effectiveRole(row.org_role, row.ws_role);
}

export async function pageRole(db: pg.Pool, userId: string, pageId: string): Promise<Role | null> {
  const rows = await query<{ workspace_id: string; page_role: Role | null }>(
    db,
    `SELECT p.workspace_id, pp.role AS page_role
       FROM pages p
       LEFT JOIN page_permissions pp ON pp.page_id = p.id AND pp.user_id = $2
      WHERE p.id = $1`,
    [pageId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  const wsRole = await workspaceRole(db, userId, row.workspace_id);
  return effectiveRole(wsRole, row.page_role);
}
