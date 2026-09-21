import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { pageRole } from "../access.js";

const BLOCK_TYPES = [
  "heading",
  "paragraph",
  "image",
  "file",
  "table",
  "database",
  "kanban",
  "checklist",
  "code",
  "quote",
  "divider",
  "embed",
  "child_page",
] as const;

async function pageIdForBlock(app: FastifyInstance, blockId: string): Promise<string | null> {
  const rows = await query<{ page_id: string }>(app.db, "SELECT page_id FROM blocks WHERE id = $1", [blockId]);
  return rows[0]?.page_id ?? null;
}

export async function registerBlockRoutes(app: FastifyInstance): Promise<void> {
  // Create a block on a page.
  app.post("/api/pages/:pageId/blocks", { preHandler: app.authenticate }, async (request, reply) => {
    const { pageId } = z.object({ pageId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        type: z.enum(BLOCK_TYPES),
        content: z.record(z.unknown()).default({}),
        parent_id: z.string().uuid().optional(),
        position: z.string().max(64).optional(),
      })
      .parse(request.body);
    assertCan(await pageRole(app.db, request.user!.id, pageId), "page:update");

    const rows = await query(
      app.db,
      `INSERT INTO blocks (page_id, parent_id, type, content, position)
       VALUES ($1,$2,$3,$4,COALESCE($5,'n')) RETURNING id, parent_id, type, content, position`,
      [pageId, body.parent_id ?? null, body.type, JSON.stringify(body.content), body.position ?? null],
    );
    return reply.code(201).send({ block: rows[0] });
  });

  // Update a block's content/position.
  app.patch("/api/blocks/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ content: z.record(z.unknown()).optional(), position: z.string().max(64).optional() }).parse(request.body);
    const pageId = await pageIdForBlock(app, id);
    if (!pageId) return reply.code(404).send({ error: "not found" });
    assertCan(await pageRole(app.db, request.user!.id, pageId), "page:update");

    const rows = await query(
      app.db,
      `UPDATE blocks SET content = COALESCE($2, content), position = COALESCE($3, position), updated_at = now()
        WHERE id = $1 RETURNING id, parent_id, type, content, position`,
      [id, body.content ? JSON.stringify(body.content) : null, body.position ?? null],
    );
    return reply.send({ block: rows[0] });
  });

  // Delete a block.
  app.delete("/api/blocks/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pageId = await pageIdForBlock(app, id);
    if (!pageId) return reply.code(404).send({ error: "not found" });
    assertCan(await pageRole(app.db, request.user!.id, pageId), "page:update");
    await query(app.db, "DELETE FROM blocks WHERE id = $1", [id]);
    return reply.code(204).send();
  });
}
