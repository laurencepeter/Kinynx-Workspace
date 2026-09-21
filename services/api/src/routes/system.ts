import type { FastifyInstance } from "fastify";

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // Liveness + dependency health (used by Docker healthcheck & admin console).
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, "ok" | "down"> = { api: "ok", database: "down" };
    try {
      await app.db.query("SELECT 1");
      checks.database = "ok";
    } catch {
      checks.database = "down";
    }
    const healthy = Object.values(checks).every((v) => v === "ok");
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? "ok" : "degraded", checks });
  });

  // Public edition/entitlements surface (drives Community vs Enterprise UI).
  app.get("/api/system/info", async () => ({
    product: "Kinynx",
    version: "0.1.0",
    edition: app.entitlements.edition,
    plan: app.entitlements.plan,
    features: app.entitlements.features,
    limits: app.entitlements.limits,
  }));
}
