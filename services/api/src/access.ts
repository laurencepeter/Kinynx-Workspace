/**
 * Resolves a user's *effective* role on a resource by walking the scope chain
 * Organization → Workspace → Page against the database, INCLUDING role grants
 * inherited through group membership (departments / project teams). This is the
 * server-side enforcement point; routes must call these before acting.
 */
import type pg from "pg";
import { effectiveRole } from "@kinynx/permissions";
import type { Role } from "@kinynx/shared";
import { query } from "./db/pool.js";

export async function orgRole(db: pg.Pool, userId: string, orgId: string): Promise<Role | null> {
  const rows = await query<{ role: Role }>(
    db,
    `SELECT om.role FROM organization_members om
      WHERE om.organization_id = $1 AND om.user_id = $2
     UNION ALL
     SELECT gg.role FROM group_grants gg
       JOIN groups g ON g.id = gg.group_id
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2
      WHERE gg.scope_type = 'organization' AND gg.scope_id = $1
     UNION ALL
     SELECT cr.base_role AS role FROM custom_role_assignments cra
       JOIN custom_roles cr ON cr.id = cra.custom_role_id
      WHERE cra.user_id = $2 AND cra.scope_type = 'organization' AND cra.scope_id = $1`,
    [orgId, userId],
  );
  return effectiveRole(...rows.map((r) => r.role));
}

export async function workspaceRole(
  db: pg.Pool,
  userId: string,
  workspaceId: string,
): Promise<Role | null> {
  // Gather every grant that could apply: org membership, org group grants,
  // workspace membership, workspace group grants. Effective = the highest.
  const rows = await query<{ role: Role }>(
    db,
    `WITH w AS (SELECT id, organization_id FROM workspaces WHERE id = $1)
     SELECT om.role FROM w JOIN organization_members om
            ON om.organization_id = w.organization_id AND om.user_id = $2
     UNION ALL
     SELECT gg.role FROM w JOIN group_grants gg ON gg.scope_type = 'organization' AND gg.scope_id = w.organization_id
            JOIN group_members gm ON gm.group_id = gg.group_id AND gm.user_id = $2
     UNION ALL
     SELECT wm.role FROM workspace_members wm WHERE wm.workspace_id = $1 AND wm.user_id = $2
     UNION ALL
     SELECT gg.role FROM group_grants gg
            JOIN group_members gm ON gm.group_id = gg.group_id AND gm.user_id = $2
      WHERE gg.scope_type = 'workspace' AND gg.scope_id = $1
     UNION ALL
     SELECT cr.base_role AS role FROM w
            JOIN custom_role_assignments cra
              ON (cra.scope_type = 'workspace' AND cra.scope_id = w.id)
              OR (cra.scope_type = 'organization' AND cra.scope_id = w.organization_id)
            JOIN custom_roles cr ON cr.id = cra.custom_role_id
      WHERE cra.user_id = $2`,
    [workspaceId, userId],
  );
  return effectiveRole(...rows.map((r) => r.role));
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

/** Resolve the organization that owns a workspace (for scoping invites, etc.). */
export async function orgIdForWorkspace(db: pg.Pool, workspaceId: string): Promise<string | null> {
  const rows = await query<{ organization_id: string }>(
    db,
    "SELECT organization_id FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  return rows[0]?.organization_id ?? null;
}
