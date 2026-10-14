import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { PLAN_DEFAULTS, type Plan } from "@kinynx/shared";
import { query } from "../db/pool.js";
import { orgRole } from "../access.js";

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  // Public plan catalog (drives pricing UI) — derived from central entitlements.
  app.get("/api/billing/plans", async () => ({
    provider: app.billing.name,
    plans: (Object.keys(PLAN_DEFAULTS) as Plan[]).map((p) => ({
      id: p,
      edition: PLAN_DEFAULTS[p].edition,
      limits: PLAN_DEFAULTS[p].limits,
      features: PLAN_DEFAULTS[p].features,
    })),
  }));

  app.get("/api/organizations/:orgId/billing", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:read");
    const org = (await query<{ plan: Plan }>(app.db, "SELECT plan FROM organizations WHERE id=$1", [orgId]))[0];
    if (!org) return reply.code(404).send({ error: "not found" });
    return reply.send({ plan: org.plan, provider: app.billing.name });
  });

  app.post("/api/organizations/:orgId/billing/checkout", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const { plan } = z.object({ plan: z.enum(["team", "enterprise"]) }).parse(request.body);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:manage_billing");
    const result = await app.billing.createCheckout({ organizationId: orgId, plan, customerEmail: request.user!.email });
    return reply.send(result);
  });
}
