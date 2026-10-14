import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { withinLimit } from "@kinynx/shared";
import { query } from "../db/pool.js";
import { orgIdForWorkspace, orgRole, workspaceRole } from "../access.js";
import { audit, hasActiveLegalHold } from "./organizations.js";

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  // List workspaces the caller can see within an organization.
  app.get("/api/organizations/:orgId/workspaces", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "workspace:read");
    const rows = await query(
      app.db,
      "SELECT id, name, icon, created_at FROM workspaces WHERE organization_id = $1 ORDER BY created_at",
      [orgId],
    );
    return reply.send({ workspaces: rows });
  });

  // Create a workspace — enforces max_workspaces.
  app.post("/api/organizations/:orgId/workspaces", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const { name, icon, color } = z
      .object({ name: z.string().min(1).max(120), icon: z.string().optional(), color: z.string().max(32).optional() })
      .parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "workspace:create");

    const count = Number(
      (await query<{ n: string }>(app.db, "SELECT count(*) n FROM workspaces WHERE organization_id = $1", [orgId]))[0]!.n,
    );
    if (!withinLimit(app.entitlements.limits.max_workspaces, count)) {
      return reply.code(402).send({ error: "workspace limit reached", edition: app.entitlements.edition });
    }

    const rows = await query(
      app.db,
      "INSERT INTO workspaces (organization_id, name, icon, color) VALUES ($1,$2,$3,$4) RETURNING id, name, icon, color, created_at",
      [orgId, name, icon ?? null, color ?? null],
    );
    return reply.code(201).send({ workspace: rows[0] });
  });

  app.get("/api/workspaces/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await workspaceRole(app.db, request.user!.id, id), "workspace:read");
    const rows = await query(app.db, "SELECT id, organization_id, name, icon, created_at FROM workspaces WHERE id = $1", [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return reply.send({ workspace: rows[0] });
  });

  app.patch("/api/workspaces/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        icon: z.string().max(16).nullable().optional(),
        color: z.string().max(32).nullable().optional(),
      })
      .parse(request.body);
    assertCan(await workspaceRole(app.db, request.user!.id, id), "workspace:update");
    const rows = await query(
      app.db,
      `UPDATE workspaces SET name = COALESCE($2, name), icon = COALESCE($3, icon), color = COALESCE($4, color)
        WHERE id = $1 RETURNING id, organization_id, name, icon, color`,
      [id, body.name ?? null, body.icon ?? null, body.color ?? null],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    const orgId = (rows[0] as { organization_id: string }).organization_id;
    await audit(app, orgId, request.user!.id, "workspace.update", "workspace", id, request.ip);
    return reply.send({ workspace: rows[0] });
  });

  // Delete a workspace (and its pages/blocks). Requires echoing the name back.
  app.delete("/api/workspaces/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(request.body ?? {});
    assertCan(await workspaceRole(app.db, request.user!.id, id), "workspace:delete");
    const ws = (await query<{ name: string }>(app.db, "SELECT name FROM workspaces WHERE id = $1", [id]))[0];
    if (!ws) return reply.code(404).send({ error: "not found" });
    if (confirm !== ws.name) return reply.code(400).send({ error: "confirmation does not match the workspace name" });
    const orgId = (await orgIdForWorkspace(app.db, id))!;
    if (await hasActiveLegalHold(app, orgId)) {
      return reply.code(409).send({ error: "organization is under an active legal hold" });
    }
    await query(app.db, "DELETE FROM workspaces WHERE id = $1", [id]);
    await audit(app, orgId, request.user!.id, "workspace.delete", "workspace", id, request.ip);
    return reply.code(204).send();
  });
}
