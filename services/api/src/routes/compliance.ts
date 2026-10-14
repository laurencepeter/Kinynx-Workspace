import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgRole } from "../access.js";
import { RETENTION_RESOURCES as RESOURCES, applyRetentionForOrg } from "../jobs/index.js";

/**
 * Data retention policies + legal hold (Enterprise compliance).
 * A retention policy deletes records of a resource older than `retain_days`.
 * An active legal hold on the org suspends ALL retention deletion for it, so
 * data under investigation is preserved. Gated on the retention_policies /
 * legal_hold entitlements.
 */

export async function registerComplianceRoutes(app: FastifyInstance): Promise<void> {
  const gate = (reply: FastifyReply, flag: "retention_policies" | "legal_hold"): boolean => {
    if (!app.entitlements.features[flag]) {
      reply.code(402).send({ error: `${flag} requires an Enterprise license`, edition: app.entitlements.edition });
      return false;
    }
    return true;
  };

  app.get("/api/organizations/:orgId/retention", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:view_audit_logs");
    const rows = await query(app.db, "SELECT resource, retain_days, updated_at FROM retention_policies WHERE organization_id=$1 ORDER BY resource", [orgId]);
    return reply.send({ policies: rows });
  });

  app.put("/api/organizations/:orgId/retention", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const body = z.object({ resource: z.enum(RESOURCES), retain_days: z.number().int().min(0).max(3650) }).parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:update");
    if (!gate(reply, "retention_policies")) return reply;
    await query(
      app.db,
      `INSERT INTO retention_policies (organization_id, resource, retain_days) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, resource) DO UPDATE SET retain_days = EXCLUDED.retain_days, updated_at = now()`,
      [orgId, body.resource, body.retain_days],
    );
    return reply.send({ ok: true });
  });

  app.get("/api/organizations/:orgId/legal-holds", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:view_audit_logs");
    const rows = await query(app.db, "SELECT id, reason, active, created_at, released_at FROM legal_holds WHERE organization_id=$1 ORDER BY created_at DESC", [orgId]);
    return reply.send({ legal_holds: rows });
  });

  app.post("/api/organizations/:orgId/legal-holds", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().max(500).default("") }).parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:update");
    if (!gate(reply, "legal_hold")) return reply;
    const row = (await query(app.db, "INSERT INTO legal_holds (organization_id, reason, created_by) VALUES ($1,$2,$3) RETURNING id, reason, active, created_at", [orgId, reason, request.user!.id]))[0];
    return reply.code(201).send({ legal_hold: row });
  });

  app.post("/api/legal-holds/:id/release", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const hold = (await query<{ organization_id: string }>(app.db, "SELECT organization_id FROM legal_holds WHERE id=$1", [id]))[0];
    if (!hold) return reply.code(404).send({ error: "not found" });
    assertCan(await orgRole(app.db, request.user!.id, hold.organization_id), "org:update");
    await query(app.db, "UPDATE legal_holds SET active=FALSE, released_at=now() WHERE id=$1", [id]);
    return reply.send({ ok: true });
  });

  // Apply retention now (a scheduled worker would call this on a cadence).
  app.post("/api/organizations/:orgId/retention/apply", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:update");
    if (!gate(reply, "retention_policies")) return reply;
    return reply.send(await applyRetentionForOrg(app.db, orgId));
  });
}
