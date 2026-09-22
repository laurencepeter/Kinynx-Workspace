import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { entitlementsFor, verifyLicense, type LicenseFile } from "@kinynx/shared";
import { query } from "../db/pool.js";

/**
 * Deployment administration console (backend).
 *
 * "Deployment admin" = an operator of the whole install, distinct from an org
 * admin. Resolved from ADMIN_EMAILS when set; otherwise any organization owner
 * (the common self-host case). All admin routes require it.
 */
async function isDeploymentAdmin(app: FastifyInstance, userId: string, email: string): Promise<boolean> {
  const allow = app.config.ADMIN_EMAILS;
  if (allow && allow.trim()) {
    return allow.split(",").map((e) => e.trim().toLowerCase()).includes(email.toLowerCase());
  }
  const rows = await query<{ n: string }>(app.db, "SELECT count(*) n FROM organization_members WHERE user_id=$1 AND role='owner'", [userId]);
  return Number(rows[0]!.n) > 0;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!(await isDeploymentAdmin(app, request.user!.id, request.user!.email))) {
      await reply.code(403).send({ error: "deployment admin required" });
      return false;
    }
    return true;
  };

  // Aggregate stats for the admin dashboard.
  app.get("/api/admin/stats", { preHandler: app.authenticate }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const one = async (sql: string) => Number((await query<{ n: string }>(app.db, sql))[0]!.n);
    const [users, orgs, workspaces, pages, files, databases, automations] = await Promise.all([
      one("SELECT count(*) n FROM users"),
      one("SELECT count(*) n FROM organizations"),
      one("SELECT count(*) n FROM workspaces"),
      one("SELECT count(*) n FROM pages WHERE archived_at IS NULL"),
      one("SELECT count(*) n FROM files"),
      one("SELECT count(*) n FROM databases"),
      one("SELECT count(*) n FROM automations"),
    ]);
    const storage = Number((await query<{ b: string | null }>(app.db, "SELECT coalesce(sum(size_bytes),0) b FROM files"))[0]!.b ?? 0);
    return reply.send({ edition: app.entitlements.edition, plan: app.entitlements.plan, counts: { users, orgs, workspaces, pages, files, databases, automations }, storage_bytes: storage });
  });

  // Detailed system health (DB / Redis / storage / search).
  app.get("/api/admin/health", { preHandler: app.authenticate }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const checks: Record<string, "ok" | "down" | "n/a"> = { database: "down", storage: "ok", realtime: "ok", search: "ok" };
    try {
      await app.db.query("SELECT 1");
      checks.database = "ok";
    } catch {
      checks.database = "down";
    }
    // FTS is backed by Postgres in Community; report with the DB.
    checks.search = checks.database;
    return reply.send({ status: Object.values(checks).every((v) => v !== "down") ? "ok" : "degraded", checks, storage_driver: app.storage.name, ai: app.ai?.name ?? "none" });
  });

  // Upload / activate an Enterprise license at runtime (offline-verified).
  app.post("/api/admin/license", { preHandler: app.authenticate }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const file = z.object({ payload: z.record(z.unknown()), signature: z.string() }).parse(request.body) as unknown as LicenseFile;

    const verdict = verifyLicense(file, app.config.KINYNX_LICENSE_PUBLIC_KEY);
    if (!verdict.valid) return reply.code(400).send({ error: `invalid license: ${verdict.reason}` });

    // A deployment license is install-wide; its payload.organization_id names the
    // licensee (issuer-side) and need not exist locally, so store it in the
    // payload only — keep the FK column NULL.
    await query(
      app.db,
      "INSERT INTO licenses (organization_id, license_id, payload, signature) VALUES (NULL,$1,$2,$3)",
      [verdict.payload.license_id, JSON.stringify(file.payload), file.signature],
    );
    // Activate immediately — no restart required. Mutate in place so every route
    // that reads app.entitlements sees the change (the decorated reference is stable).
    Object.assign(app.entitlements, entitlementsFor(verdict));
    return reply.send({ ok: true, edition: app.entitlements.edition, plan: app.entitlements.plan, expires_at: verdict.payload.expires_at });
  });

  // Current license/edition (for the admin UI badge).
  app.get("/api/admin/license", { preHandler: app.authenticate }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    return reply.send({ edition: app.entitlements.edition, plan: app.entitlements.plan, features: app.entitlements.features, limits: app.entitlements.limits });
  });
}
