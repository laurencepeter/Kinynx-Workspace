import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { withinLimit } from "@kinynx/shared";
import { query } from "../db/pool.js";
import { orgRole } from "../access.js";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "org"
  ) + "-" + Math.random().toString(36).slice(2, 7);
}

export async function registerOrgRoutes(app: FastifyInstance): Promise<void> {
  // List organizations the caller belongs to.
  app.get("/api/organizations", { preHandler: app.authenticate }, async (request) => {
    const rows = await query(
      app.db,
      `SELECT o.id, o.name, o.slug, o.plan, m.role
         FROM organizations o JOIN organization_members m ON m.organization_id = o.id
        WHERE m.user_id = $1 ORDER BY o.created_at`,
      [request.user!.id],
    );
    return { organizations: rows };
  });

  // Create an organization; the creator becomes owner.
  app.post("/api/organizations", { preHandler: app.authenticate }, async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const org = (
        await client.query(
          "INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id, name, slug, plan",
          [name, slugify(name)],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')",
        [org.id, request.user!.id],
      );
      await client.query(
        "INSERT INTO audit_logs (organization_id, actor_id, action, target_type, target_id, ip) VALUES ($1,$2,'org.create','organization',$3,$4)",
        [org.id, request.user!.id, org.id, request.ip],
      );
      await client.query("COMMIT");
      return reply.code(201).send({ organization: { ...org, role: "owner" } });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // Add a member — enforces the licensed max_users limit.
  app.post("/api/organizations/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ user_id: z.string().uuid(), role: z.enum(["admin", "editor", "commenter", "viewer"]) })
      .parse(request.body);

    assertCan(await orgRole(app.db, request.user!.id, id), "org:manage_members");

    const count = Number(
      (await query<{ n: string }>(app.db, "SELECT count(*) n FROM organization_members WHERE organization_id = $1", [id]))[0]!.n,
    );
    if (!withinLimit(app.entitlements.limits.max_users, count)) {
      return reply.code(402).send({
        error: `user limit reached (${app.entitlements.limits.max_users}). Upgrade plan to add more members.`,
        edition: app.entitlements.edition,
      });
    }

    await query(
      app.db,
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, body.user_id, body.role],
    );
    return reply.code(201).send({ ok: true });
  });
}
