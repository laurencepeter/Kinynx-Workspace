import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgRole } from "../access.js";

/**
 * Groups = departments / project teams. A group can be granted a role on a
 * workspace or the whole org, so you can "invite a whole team to a project".
 * Groups may be manual or synced from a directory (LDAP / Authentik / OIDC /
 * SCIM) — see enterprise/directory-discovery and the `source` column.
 */
export async function registerGroupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/organizations/:orgId/groups", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:read");
    const rows = await query(
      app.db,
      `SELECT g.id, g.name, g.description, g.color, g.icon, g.source,
              (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
         FROM groups g WHERE g.organization_id = $1 ORDER BY g.name`,
      [orgId],
    );
    return reply.send({ groups: rows });
  });

  app.post("/api/organizations/:orgId/groups", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        color: z.string().max(32).optional(),
        icon: z.string().max(64).optional(),
      })
      .parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:manage_members");
    const rows = await query(
      app.db,
      `INSERT INTO groups (organization_id, name, description, color, icon)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, description, color, icon, source`,
      [orgId, body.name, body.description ?? "", body.color ?? null, body.icon ?? null],
    );
    return reply.code(201).send({ group: rows[0] });
  });

  app.post("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { user_id } = z.object({ user_id: z.string().uuid() }).parse(request.body);
    const orgId = await groupOrg(app, id);
    if (!orgId) return reply.code(404).send({ error: "group not found" });
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:manage_members");
    await query(
      app.db,
      "INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [id, user_id],
    );
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(request.params);
    const orgId = await groupOrg(app, id);
    if (!orgId) return reply.code(404).send({ error: "group not found" });
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:manage_members");
    await query(app.db, "DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [id, userId]);
    return reply.code(204).send();
  });

  // Grant a group a role on a workspace (or the org).
  app.post("/api/groups/:id/grants", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        scope_type: z.enum(["organization", "workspace"]),
        scope_id: z.string().uuid(),
        role: z.enum(["admin", "editor", "commenter", "viewer"]),
      })
      .parse(request.body);
    const orgId = await groupOrg(app, id);
    if (!orgId) return reply.code(404).send({ error: "group not found" });
    // The scope must belong to the group's org; requester must be an org admin.
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:manage_members");
    if (body.scope_type === "workspace") {
      const ok = await query(app.db, "SELECT 1 FROM workspaces WHERE id = $1 AND organization_id = $2", [
        body.scope_id,
        orgId,
      ]);
      if (ok.length === 0) return reply.code(400).send({ error: "workspace not in this organization" });
    } else if (body.scope_id !== orgId) {
      return reply.code(400).send({ error: "organization scope must be the group's org" });
    }
    await query(
      app.db,
      `INSERT INTO group_grants (group_id, scope_type, scope_id, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (group_id, scope_type, scope_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, body.scope_type, body.scope_id, body.role],
    );
    return reply.code(201).send({ ok: true });
  });
}

async function groupOrg(app: FastifyInstance, groupId: string): Promise<string | null> {
  const rows = await query<{ organization_id: string }>(
    app.db,
    "SELECT organization_id FROM groups WHERE id = $1",
    [groupId],
  );
  return rows[0]?.organization_id ?? null;
}
