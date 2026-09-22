import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgRole } from "../access.js";

/**
 * Data retention policies + legal hold (Enterprise compliance).
 * A retention policy deletes records of a resource older than `retain_days`.
 * An active legal hold on the org suspends ALL retention deletion for it, so
 * data under investigation is preserved. Gated on the retention_policies /
 * legal_hold entitlements.
 */
const RESOURCES = ["audit_logs", "notifications"] as const;

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

    const held = await query(app.db, "SELECT 1 FROM legal_holds WHERE organization_id=$1 AND active LIMIT 1", [orgId]);
    if (held.length > 0) return reply.send({ applied: false, reason: "legal hold active", deleted: {} });

    const policies = await query<{ resource: string; retain_days: number }>(app.db, "SELECT resource, retain_days FROM retention_policies WHERE organization_id=$1", [orgId]);
    const deleted: Record<string, number> = {};
    for (const p of policies) {
      // Resource name is from a fixed allowlist (RESOURCES), never user free-text.
      if (!(RESOURCES as readonly string[]).includes(p.resource)) continue;
      const res = await app.db.query(
        `DELETE FROM ${p.resource} WHERE organization_id=$1 AND created_at < now() - ($2 || ' days')::interval`,
        [orgId, String(p.retain_days)],
      );
      deleted[p.resource] = res.rowCount ?? 0;
    }
    return reply.send({ applied: true, deleted });
  });
}
