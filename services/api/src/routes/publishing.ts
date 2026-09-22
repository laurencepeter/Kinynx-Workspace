import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { pageRole } from "../access.js";

function slugify(s: string): string {
  return (
    (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "page") +
    "-" +
    Math.random().toString(36).slice(2, 7)
  );
}

/** Public, read-only publishing of pages with SEO metadata and optional password. */
export async function registerPublishingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/pages/:id/publish", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/).optional(),
        password: z.string().min(8).max(100).nullable().optional(),
        seo: z.object({ title: z.string().max(200).optional(), description: z.string().max(400).optional(), image: z.string().url().optional() }).default({}),
      })
      .parse(request.body);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:publish");

    const page = (await query<{ title: string }>(app.db, "SELECT title FROM pages WHERE id=$1", [id]))[0];
    if (!page) return reply.code(404).send({ error: "not found" });

    const slug = body.slug ?? slugify(page.title);
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    try {
      const pub = (
        await query(
          app.db,
          `INSERT INTO publications (page_id, slug, password_hash, seo, published_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (page_id) DO UPDATE SET slug = EXCLUDED.slug, password_hash = EXCLUDED.password_hash,
             seo = EXCLUDED.seo, enabled = TRUE, updated_at = now()
           RETURNING slug, enabled`,
          [id, slug, passwordHash, JSON.stringify(body.seo), request.user!.id],
        )
      )[0] as { slug: string };
      const url = `${app.config.PUBLIC_APP_URL}/p/${pub.slug}`;
      return reply.code(201).send({ slug: pub.slug, url, password_protected: passwordHash != null });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "slug already taken" });
      throw err;
    }
  });

  app.delete("/api/pages/:id/publish", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:publish");
    await query(app.db, "UPDATE publications SET enabled = FALSE WHERE page_id=$1", [id]);
    return reply.code(204).send();
  });

  // PUBLIC — no auth. Read-only rendering of a published page. Rate-limited to
  // blunt password brute-force on protected pages while allowing normal viewing.
  app.get("/api/public/:slug", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string().min(1).max(80) }).parse(request.params);
    const pub = (
      await query<{ page_id: string; password_hash: string | null; seo: unknown }>(
        app.db,
        "SELECT page_id, password_hash, seo FROM publications WHERE slug=$1 AND enabled",
        [slug],
      )
    )[0];
    if (!pub) return reply.code(404).send({ error: "not found" });

    if (pub.password_hash) {
      const supplied = (request.headers["x-page-password"] as string) ?? (request.query as { password?: string }).password ?? "";
      if (!(await verifyPassword(pub.password_hash, supplied))) {
        return reply.code(401).send({ error: "password required", password_protected: true });
      }
    }

    const page = (await query(app.db, "SELECT id, title, icon FROM pages WHERE id=$1 AND archived_at IS NULL", [pub.page_id]))[0];
    if (!page) return reply.code(404).send({ error: "not found" });
    const blocks = await query(app.db, "SELECT id, parent_id, type, content, position FROM blocks WHERE page_id=$1 ORDER BY position", [pub.page_id]);
    await query(app.db, "UPDATE publications SET view_count = view_count + 1 WHERE slug=$1", [slug]);
    return reply.send({ page, blocks, seo: pub.seo });
  });
}
