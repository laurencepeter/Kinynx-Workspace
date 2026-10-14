import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgIdForWorkspace, pageRole, workspaceRole } from "../access.js";

export async function registerPageRoutes(app: FastifyInstance): Promise<void> {
  // List the page tree (flat; client builds nesting from parent_id) for a workspace.
  app.get("/api/workspaces/:workspaceId/pages", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "page:read");
    const rows = await query(
      app.db,
      `SELECT id, parent_id, title, icon, color, position, updated_at
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
        color: z.string().max(32).optional(),
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
      `INSERT INTO pages (workspace_id, parent_id, title, icon, color, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, parent_id, title, icon, color, position, updated_at`,
      [workspaceId, body.parent_id ?? null, body.title ?? "Untitled", body.icon ?? null, body.color ?? null, request.user!.id],
    );
    const created = rows[0] as { id: string; title: string };
    const orgId = await orgIdForWorkspace(app.db, workspaceId);
    if (orgId) {
      app.events.publish({
        type: "page.created",
        workspaceId,
        organizationId: orgId,
        actorEmail: request.user!.email,
        data: { page_id: created.id, title: created.title },
      });
    }
    return reply.code(201).send({ page: created });
  });

  // Get a page with its blocks.
  app.get("/api/pages/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:read");
    const pages = await query(
      app.db,
      `SELECT p.id, p.workspace_id, p.parent_id, p.title, p.icon, p.created_at, p.updated_at, u.email AS created_by_email
         FROM pages p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`,
      [id],
    );
    if (pages.length === 0) return reply.code(404).send({ error: "not found" });
    const blocks = await query(
      app.db,
      `SELECT b.id, b.parent_id, b.type, b.content, b.position, b.created_at, b.updated_at,
              cu.email AS created_by_email, uu.email AS updated_by_email
         FROM blocks b
         LEFT JOIN users cu ON cu.id = b.created_by
         LEFT JOIN users uu ON uu.id = b.updated_by
        WHERE b.page_id = $1 ORDER BY b.position, b.created_at`,
      [id],
    );
    return reply.send({ page: pages[0], blocks });
  });

  // Update page metadata.
  app.patch("/api/pages/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ title: z.string().max(400).optional(), icon: z.string().nullable().optional() }).parse(request.body);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:update");
    const rows = await query<{ id: string; title: string; icon: string | null; workspace_id: string }>(
      app.db,
      `UPDATE pages SET title = COALESCE($2, title), icon = COALESCE($3, icon)
        WHERE id = $1 RETURNING id, title, icon, workspace_id, updated_at`,
      [id, body.title ?? null, body.icon ?? null],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    app.hub.publish(rows[0]!.workspace_id, { type: "page.updated", pageId: id, by: request.user!.email });
    return reply.send({ page: rows[0] });
  });

  // Soft-delete (archive) a page.
  app.delete("/api/pages/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:delete");
    await query(app.db, "UPDATE pages SET archived_at = now() WHERE id = $1", [id]);
    return reply.code(204).send();
  });

  // Global full-text search: pages (title + body), comments, users, and public
  // templates. Everything is scoped to what the caller can see.
  app.get("/api/search", { preHandler: app.authenticate }, async (request, reply) => {
    const { q } = z.object({ q: z.string().min(1).max(200) }).parse(request.query);
    const uid = request.user!.id;

    // Pages the caller can read where the title OR any block body matches.
    const pages = await query(
      app.db,
      `SELECT DISTINCT p.id, p.title, p.workspace_id
         FROM pages p
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = $2
        WHERE p.archived_at IS NULL
          AND (p.search_tsv @@ plainto_tsquery('english', $1)
               OR EXISTS (SELECT 1 FROM blocks b WHERE b.page_id = p.id AND b.search_tsv @@ plainto_tsquery('english', $1)))
        LIMIT 30`,
      [q, uid],
    );

    // Comments in the caller's workspaces.
    const comments = await query(
      app.db,
      `SELECT c.id, c.target_type, c.target_id, left(c.body, 160) AS excerpt
         FROM comments c
         JOIN workspaces w ON w.id = c.workspace_id
         JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = $2
        WHERE to_tsvector('english', c.body) @@ plainto_tsquery('english', $1)
        LIMIT 15`,
      [q, uid],
    );

    // People in the caller's organizations.
    const users = await query(
      app.db,
      `SELECT DISTINCT u.id, u.email, u.display_name
         FROM users u
         JOIN organization_members m ON m.user_id = u.id
         JOIN organization_members me ON me.organization_id = m.organization_id AND me.user_id = $2
        WHERE u.email_norm LIKE '%' || lower($1) || '%' OR u.display_name ILIKE '%' || $1 || '%'
        LIMIT 10`,
      [q, uid],
    );

    // Public marketplace templates.
    const templates = await query(
      app.db,
      `SELECT id, name, category FROM templates
        WHERE published AND search_tsv @@ plainto_tsquery('english', $1) LIMIT 10`,
      [q],
    );

    return reply.send({
      // `results` kept for backwards compatibility (pages).
      results: pages,
      pages,
      comments,
      users,
      templates,
    });
  });
}
