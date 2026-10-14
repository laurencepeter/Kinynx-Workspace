import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { pageRole, workspaceRole } from "../access.js";
import { exportSubtree, importSubtree, portablePageSchema, type PortablePage } from "./portability.js";

const CATEGORIES = [
  "Project Management", "Bug Tracking", "CRM", "Product Roadmap", "Software Documentation",
  "Meeting Notes", "Personal Wiki", "Knowledge Base", "HR", "Marketing", "Engineering", "DevOps", "Other",
] as const;

interface TemplatePackage {
  manifest: { spec_version: string; name: string; version: string; description: string; category: string; tags: string[]; created_at: string };
  content: { page: PortablePage };
}

function buildZip(pkg: TemplatePackage): Buffer {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(pkg.manifest, null, 2)));
  zip.addFile("content/page.json", Buffer.from(JSON.stringify(pkg.content.page, null, 2)));
  return zip.toBuffer();
}

function parseZip(buf: Buffer): TemplatePackage {
  const zip = new AdmZip(buf);
  const manifest = JSON.parse(zip.getEntry("manifest.json")?.getData().toString("utf8") ?? "{}");
  const page = JSON.parse(zip.getEntry("content/page.json")?.getData().toString("utf8") ?? "null");
  return { manifest, content: { page } };
}

export async function registerTemplateRoutes(app: FastifyInstance): Promise<void> {
  // Publish a template from a page subtree.
  app.post("/api/templates", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(160),
        description: z.string().max(2000).default(""),
        category: z.enum(CATEGORIES).default("Other"),
        tags: z.array(z.string().max(40)).max(20).default([]),
        page_id: z.string().uuid(),
      })
      .parse(request.body);
    assertCan(await pageRole(app.db, request.user!.id, body.page_id), "page:read");

    const page = await exportSubtree(app.db, body.page_id);
    const pkg: TemplatePackage = {
      manifest: { spec_version: "1.0", name: body.name, version: "1.0.0", description: body.description, category: body.category, tags: body.tags, created_at: new Date().toISOString() },
      content: { page },
    };
    const row = (
      await query(
        app.db,
        "INSERT INTO templates (author_id, name, description, category, tags, package) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, category, version, created_at",
        [request.user!.id, body.name, body.description, body.category, body.tags, JSON.stringify(pkg)],
      )
    )[0];
    return reply.code(201).send({ template: row });
  });

  // Public marketplace search (no auth — templates are freely downloadable).
  app.get("/api/templates", async (request, reply) => {
    const q = z.object({ q: z.string().max(200).optional(), category: z.enum(CATEGORIES).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const where: string[] = ["t.published"];
    const params: unknown[] = [];
    if (q.q) { params.push(q.q); where.push(`t.search_tsv @@ plainto_tsquery('english', $${params.length})`); }
    if (q.category) { params.push(q.category); where.push(`t.category = $${params.length}`); }
    params.push(q.limit);
    const rows = await query(
      app.db,
      `SELECT t.id, t.name, t.description, t.category, t.tags, t.version, t.downloads, u.email AS author,
              coalesce(avg(r.rating),0)::numeric(3,2) AS rating, count(r.*) AS ratings
         FROM templates t
         LEFT JOIN users u ON u.id = t.author_id
         LEFT JOIN template_ratings r ON r.template_id = t.id
        WHERE ${where.join(" AND ")}
        GROUP BY t.id, u.email
        ORDER BY t.downloads DESC, t.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return reply.send({ templates: rows });
  });

  app.get("/api/templates/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await query(
      app.db,
      `SELECT t.id, t.name, t.description, t.category, t.tags, t.version, t.downloads, u.email AS author,
              coalesce(avg(r.rating),0)::numeric(3,2) AS rating, count(r.*) AS ratings
         FROM templates t LEFT JOIN users u ON u.id = t.author_id
         LEFT JOIN template_ratings r ON r.template_id = t.id
        WHERE t.id=$1 AND t.published GROUP BY t.id, u.email`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return reply.send({ template: rows[0] });
  });

  // Download the portable package (JSON). Public. Counts as a download.
  app.get("/api/templates/:id/download", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = (await query<{ package: TemplatePackage }>(app.db, "SELECT package FROM templates WHERE id=$1 AND published", [id]))[0];
    if (!row) return reply.code(404).send({ error: "not found" });
    await query(app.db, "UPDATE templates SET downloads = downloads + 1 WHERE id=$1", [id]);
    return reply.send(row.package);
  });

  // Download as a .template.zip file. Public.
  app.get("/api/templates/:id/download.zip", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = (await query<{ package: TemplatePackage; name: string }>(app.db, "SELECT package, name FROM templates WHERE id=$1 AND published", [id]))[0];
    if (!row) return reply.code(404).send({ error: "not found" });
    await query(app.db, "UPDATE templates SET downloads = downloads + 1 WHERE id=$1", [id]);
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="${row.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.template.zip"`);
    return reply.send(buildZip(row.package));
  });

  // Import a marketplace template into a workspace.
  app.post("/api/templates/:id/import", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { workspace_id, parent_id } = z.object({ workspace_id: z.string().uuid(), parent_id: z.string().uuid().optional() }).parse(request.body);
    assertCan(await workspaceRole(app.db, request.user!.id, workspace_id), "page:create");
    const row = (await query<{ package: TemplatePackage }>(app.db, "SELECT package FROM templates WHERE id=$1 AND published", [id]))[0];
    if (!row) return reply.code(404).send({ error: "not found" });
    const page = portablePageSchema.parse(row.package.content.page);

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const rootId = await importSubtree(client, workspace_id, parent_id ?? null, page, request.user!.id);
      await client.query("COMMIT");
      await query(app.db, "UPDATE templates SET downloads = downloads + 1 WHERE id=$1", [id]);
      return reply.code(201).send({ page_id: rootId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // Import an uploaded .template.zip into a workspace (octet-stream body).
  app.post(
    "/api/workspaces/:workspaceId/templates/import-zip",
    { preHandler: app.authenticate, bodyLimit: 25 * 1024 * 1024 },
    async (request, reply) => {
      const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
      assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "page:create");
      const buf = request.body as Buffer;
      if (!Buffer.isBuffer(buf)) return reply.code(400).send({ error: "send the .template.zip as application/octet-stream" });
      let page: PortablePage;
      try {
        page = portablePageSchema.parse(parseZip(buf).content.page);
      } catch {
        return reply.code(400).send({ error: "invalid .template.zip" });
      }
      const client = await app.db.connect();
      try {
        await client.query("BEGIN");
        const rootId = await importSubtree(client, workspaceId, null, page, request.user!.id);
        await client.query("COMMIT");
        return reply.code(201).send({ page_id: rootId });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  );

  app.post("/api/templates/:id/rate", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rating } = z.object({ rating: z.number().int().min(1).max(5) }).parse(request.body);
    const exists = await query(app.db, "SELECT 1 FROM templates WHERE id=$1 AND published", [id]);
    if (exists.length === 0) return reply.code(404).send({ error: "not found" });
    await query(
      app.db,
      "INSERT INTO template_ratings (template_id, user_id, rating) VALUES ($1,$2,$3) ON CONFLICT (template_id, user_id) DO UPDATE SET rating = EXCLUDED.rating",
      [id, request.user!.id, rating],
    );
    return reply.send({ ok: true });
  });

  app.get("/api/templates/categories", async () => ({ categories: CATEGORIES }));
}
