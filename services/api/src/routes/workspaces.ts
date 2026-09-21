import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { withinLimit } from "@kinynx/shared";
import { query } from "../db/pool.js";
import { orgRole, workspaceRole } from "../access.js";

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
    const { name, icon } = z.object({ name: z.string().min(1).max(120), icon: z.string().optional() }).parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "workspace:create");

    const count = Number(
      (await query<{ n: string }>(app.db, "SELECT count(*) n FROM workspaces WHERE organization_id = $1", [orgId]))[0]!.n,
    );
    if (!withinLimit(app.entitlements.limits.max_workspaces, count)) {
      return reply.code(402).send({ error: "workspace limit reached", edition: app.entitlements.edition });
    }

    const rows = await query(
      app.db,
      "INSERT INTO workspaces (organization_id, name, icon) VALUES ($1,$2,$3) RETURNING id, name, icon, created_at",
      [orgId, name, icon ?? null],
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
}
