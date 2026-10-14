import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { workspaceRole } from "../access.js";

/**
 * Integration registry. An integration is a configured connection to an
 * external service that automation actions can call (Slack/Discord incoming
 * webhooks, generic webhooks, and — later — GitHub/GitLab/Teams). Secrets in
 * `config` are never returned by the list endpoint.
 */
const PROVIDERS = ["webhook", "slack", "discord", "teams", "github", "gitlab"] as const;

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  // Advertise the framework's supported providers (drives setup UI).
  app.get("/api/integrations/providers", async () => ({
    providers: PROVIDERS.map((p) => ({ id: p, incoming_webhook: ["webhook", "slack", "discord", "teams"].includes(p) })),
  }));

  app.get("/api/workspaces/:workspaceId/integrations", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "workspace:read");
    // NOTE: config (secrets) deliberately omitted.
    const rows = await query(app.db, "SELECT id, provider, name, enabled, created_at FROM integrations WHERE workspace_id=$1 ORDER BY created_at", [workspaceId]);
    return reply.send({ integrations: rows });
  });

  app.post("/api/workspaces/:workspaceId/integrations", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = z.object({ provider: z.enum(PROVIDERS), name: z.string().min(1).max(120), config: z.record(z.unknown()).default({}) }).parse(request.body);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "workspace:update");
    const row = (
      await query(
        app.db,
        "INSERT INTO integrations (workspace_id, provider, name, config, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, provider, name, enabled",
        [workspaceId, body.provider, body.name, JSON.stringify(body.config), request.user!.id],
      )
    )[0];
    return reply.code(201).send({ integration: row });
  });

  app.delete("/api/integrations/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = (await query<{ workspace_id: string }>(app.db, "SELECT workspace_id FROM integrations WHERE id=$1", [id]))[0];
    if (!row) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, row.workspace_id), "workspace:update");
    await query(app.db, "DELETE FROM integrations WHERE id=$1", [id]);
    return reply.code(204).send();
  });
}
