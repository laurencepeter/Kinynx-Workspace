import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgRole } from "../access.js";

/**
 * Organization security policies (Enterprise advanced_security): IP allowlist
 * and an org-wide MFA requirement. Enforcement lives in security/policy.ts and
 * runs at authentication; this route only manages the settings.
 */
export async function registerSecurityRoutes(app: FastifyInstance): Promise<void> {
  const gate = (reply: FastifyReply): boolean => {
    if (!app.entitlements.features.advanced_security) {
      reply.code(402).send({ error: "security policies require an Enterprise license", edition: app.entitlements.edition });
      return false;
    }
    return true;
  };

  app.get("/api/organizations/:orgId/security", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:update");
    const row = (await query<{ security: unknown }>(app.db, "SELECT security FROM organizations WHERE id=$1", [orgId]))[0];
    if (!row) return reply.code(404).send({ error: "not found" });
    return reply.send({ security: row.security });
  });

  app.put("/api/organizations/:orgId/security", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        ip_allowlist: z.array(z.string().max(64)).max(200).optional(),
        require_mfa: z.boolean().optional(),
      })
      .parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:update");
    if (!gate(reply)) return reply;

    const current = (await query<{ security: Record<string, unknown> }>(app.db, "SELECT security FROM organizations WHERE id=$1", [orgId]))[0];
    if (!current) return reply.code(404).send({ error: "not found" });
    const security = { ...current.security };
    if (body.ip_allowlist !== undefined) security.ip_allowlist = body.ip_allowlist;
    if (body.require_mfa !== undefined) security.require_mfa = body.require_mfa;
    await query(app.db, "UPDATE organizations SET security=$2 WHERE id=$1", [orgId, JSON.stringify(security)]);
    return reply.send({ security });
  });
}
