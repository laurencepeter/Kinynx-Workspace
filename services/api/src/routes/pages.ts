import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { pageRole, workspaceRole } from "../access.js";

export async function registerPageRoutes(app: FastifyInstance): Promise<void> {
  // List the page tree (flat; client builds nesting from parent_id) for a workspace.
  app.get("/api/workspaces/:workspaceId/pages", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "page:read");
    const rows = await query(
      app.db,
      `SELECT id, parent_id, title, icon, position, updated_at
         FROM pages WHERE workspace_id = $1 AND archived_at IS NULL
        ORDER BY position, created_at`,
      [workspaceId],
    );
    return reply.send({ pages: rows });
  });

  // Create a page (optionally nested under parent_id).
  app.post("/api/workspaces/:workspaceId/pages", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        title: z.string().max(400).optional(),
        parent_id: z.string().uuid().optional(),
        icon: z.string().optional(),
      })
      .parse(request.body);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "page:create");

    if (body.parent_id) {
      const parent = await query(app.db, "SELECT 1 FROM pages WHERE id = $1 AND workspace_id = $2", [
        body.parent_id,
        workspaceId,
      ]);
      if (parent.length === 0) return reply.code(400).send({ error: "parent_id not in this workspace" });
    }

    const rows = await query(
      app.db,
      `INSERT INTO pages (workspace_id, parent_id, title, icon, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, parent_id, title, icon, position, updated_at`,
      [workspaceId, body.parent_id ?? null, body.title ?? "Untitled", body.icon ?? null, request.user!.id],
    );
    return reply.code(201).send({ page: rows[0] });
  });

  // Get a page with its blocks.
  app.get("/api/pages/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:read");
    const pages = await query(app.db, "SELECT id, workspace_id, parent_id, title, icon FROM pages WHERE id = $1", [id]);
    if (pages.length === 0) return reply.code(404).send({ error: "not found" });
    const blocks = await query(
      app.db,
      "SELECT id, parent_id, type, content, position FROM blocks WHERE page_id = $1 ORDER BY position",
      [id],
    );
    return reply.send({ page: pages[0], blocks });
  });

  // Update page metadata.
  app.patch("/api/pages/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ title: z.string().max(400).optional(), icon: z.string().nullable().optional() }).parse(request.body);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:update");
    const rows = await query(
      app.db,
      `UPDATE pages SET title = COALESCE($2, title), icon = COALESCE($3, icon)
        WHERE id = $1 RETURNING id, title, icon, updated_at`,
      [id, body.title ?? null, body.icon ?? null],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return reply.send({ page: rows[0] });
  });

  // Soft-delete (archive) a page.
  app.delete("/api/pages/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:delete");
    await query(app.db, "UPDATE pages SET archived_at = now() WHERE id = $1", [id]);
    return reply.code(204).send();
  });

  // Global full-text search across pages the caller can read.
  app.get("/api/search", { preHandler: app.authenticate }, async (request, reply) => {
    const { q } = z.object({ q: z.string().min(1).max(200) }).parse(request.query);
    const rows = await query(
      app.db,
      `SELECT p.id, p.title, p.workspace_id
         FROM pages p
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = $2
        WHERE p.archived_at IS NULL AND p.search_tsv @@ plainto_tsquery('english', $1)
        LIMIT 50`,
      [q, request.user!.id],
    );
    return reply.send({ results: rows });
  });
}
