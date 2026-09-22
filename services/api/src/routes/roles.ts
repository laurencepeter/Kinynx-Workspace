import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgRole } from "../access.js";

/**
 * Custom roles (Enterprise `advanced_permissions`). Org-defined named roles with
 * a base permission level, assignable to members at org/workspace scope. They
 * elevate a user's effective role via the same rank logic used everywhere, so
 * enforcement stays centralized — a custom role can only grant, never restrict.
 */
export async function registerRoleRoutes(app: FastifyInstance): Promise<void> {
  const requireFeature = (reply: import("fastify").FastifyReply): boolean => {
    if (!app.entitlements.features.advanced_permissions) {
      reply.code(402).send({ error: "custom roles require advanced_permissions (Team/Enterprise)", edition: app.entitlements.edition });
      return false;
    }
    return true;
  };

  async function roleOrg(id: string): Promise<string | null> {
    const r = await query<{ organization_id: string }>(app.db, "SELECT organization_id FROM custom_roles WHERE id=$1", [id]);
    return r[0]?.organization_id ?? null;
  }

  app.get("/api/organizations/:orgId/roles", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:read");
    const rows = await query(app.db, "SELECT id, name, base_role, extra_actions, created_at FROM custom_roles WHERE organization_id=$1 ORDER BY name", [orgId]);
    return reply.send({ roles: rows });
  });

  app.post("/api/organizations/:orgId/roles", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ name: z.string().min(1).max(80), base_role: z.enum(["admin", "editor", "commenter", "viewer"]), extra_actions: z.array(z.string().max(60)).max(50).default([]) })
      .parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:manage_members");
    if (!requireFeature(reply)) return reply;
    const row = (
      await query(app.db, "INSERT INTO custom_roles (organization_id, name, base_role, extra_actions) VALUES ($1,$2,$3,$4) RETURNING id, name, base_role, extra_actions", [orgId, body.name, body.base_role, body.extra_actions])
    )[0];
    return reply.code(201).send({ role: row });
  });

  app.delete("/api/roles/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const org = await roleOrg(id);
    if (!org) return reply.code(404).send({ error: "not found" });
    assertCan(await orgRole(app.db, request.user!.id, org), "org:manage_members");
    await query(app.db, "DELETE FROM custom_roles WHERE id=$1", [id]);
    return reply.code(204).send();
  });

  // Assign a custom role to a member at an org/workspace scope.
  app.post("/api/roles/:id/assign", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ user_id: z.string().uuid(), scope_type: z.enum(["organization", "workspace"]), scope_id: z.string().uuid() }).parse(request.body);
    const org = await roleOrg(id);
    if (!org) return reply.code(404).send({ error: "not found" });
    assertCan(await orgRole(app.db, request.user!.id, org), "org:manage_members");
    if (!requireFeature(reply)) return reply;
    // Scope must belong to the role's org.
    if (body.scope_type === "workspace") {
      const ok = await query(app.db, "SELECT 1 FROM workspaces WHERE id=$1 AND organization_id=$2", [body.scope_id, org]);
      if (ok.length === 0) return reply.code(400).send({ error: "workspace not in this organization" });
    } else if (body.scope_id !== org) {
      return reply.code(400).send({ error: "organization scope must be the role's org" });
    }
    await query(
      app.db,
      "INSERT INTO custom_role_assignments (custom_role_id, user_id, scope_type, scope_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [id, body.user_id, body.scope_type, body.scope_id],
    );
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/roles/:id/unassign", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ user_id: z.string().uuid(), scope_type: z.enum(["organization", "workspace"]), scope_id: z.string().uuid() }).parse(request.body);
    const org = await roleOrg(id);
    if (!org) return reply.code(404).send({ error: "not found" });
    assertCan(await orgRole(app.db, request.user!.id, org), "org:manage_members");
    await query(app.db, "DELETE FROM custom_role_assignments WHERE custom_role_id=$1 AND user_id=$2 AND scope_type=$3 AND scope_id=$4", [id, body.user_id, body.scope_type, body.scope_id]);
    return reply.code(204).send();
  });
}
