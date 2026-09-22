import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { workspaceRole } from "../access.js";

const TRIGGERS = ["page.created", "record.created", "record.updated", "comment.added", "task.completed", "invite.accepted"] as const;
const actionSchema = z.object({ type: z.string().min(1).max(40), config: z.record(z.unknown()).default({}) });

export async function registerAutomationRoutes(app: FastifyInstance): Promise<void> {
  async function autoWs(id: string): Promise<string | null> {
    const r = await query<{ workspace_id: string }>(app.db, "SELECT workspace_id FROM automations WHERE id=$1", [id]);
    return r[0]?.workspace_id ?? null;
  }

  app.get("/api/workspaces/:workspaceId/automations", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "workspace:read");
    const rows = await query(app.db, "SELECT id, name, enabled, trigger_type, trigger_filter, actions, created_at FROM automations WHERE workspace_id=$1 ORDER BY created_at", [workspaceId]);
    return reply.send({ automations: rows });
  });

  app.post("/api/workspaces/:workspaceId/automations", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(160),
        trigger_type: z.enum(TRIGGERS),
        trigger_filter: z.record(z.unknown()).default({}),
        actions: z.array(actionSchema).min(1).max(20),
      })
      .parse(request.body);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "workspace:update");
    const row = (
      await query(
        app.db,
        `INSERT INTO automations (workspace_id, name, trigger_type, trigger_filter, actions, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, enabled, trigger_type, trigger_filter, actions`,
        [workspaceId, body.name, body.trigger_type, JSON.stringify(body.trigger_filter), JSON.stringify(body.actions), request.user!.id],
      )
    )[0];
    return reply.code(201).send({ automation: row });
  });

  app.patch("/api/automations/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ enabled: z.boolean().optional(), name: z.string().max(160).optional(), actions: z.array(actionSchema).optional(), trigger_filter: z.record(z.unknown()).optional() }).parse(request.body);
    const ws = await autoWs(id);
    if (!ws) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, ws), "workspace:update");
    const row = (
      await query(
        app.db,
        `UPDATE automations SET enabled = COALESCE($2, enabled), name = COALESCE($3, name),
           actions = COALESCE($4, actions), trigger_filter = COALESCE($5, trigger_filter)
         WHERE id=$1 RETURNING id, name, enabled, trigger_type, trigger_filter, actions`,
        [id, body.enabled ?? null, body.name ?? null, body.actions ? JSON.stringify(body.actions) : null, body.trigger_filter ? JSON.stringify(body.trigger_filter) : null],
      )
    )[0];
    return reply.send({ automation: row });
  });

  app.delete("/api/automations/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ws = await autoWs(id);
    if (!ws) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, ws), "workspace:update");
    await query(app.db, "DELETE FROM automations WHERE id=$1", [id]);
    return reply.code(204).send();
  });

  app.get("/api/automations/:id/runs", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ws = await autoWs(id);
    if (!ws) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, ws), "workspace:update");
    const rows = await query(app.db, "SELECT status, event, result, created_at FROM automation_runs WHERE automation_id=$1 ORDER BY created_at DESC LIMIT 50", [id]);
    return reply.send({ runs: rows });
  });
}
