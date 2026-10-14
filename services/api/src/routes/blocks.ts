import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { pageRole } from "../access.js";

const BLOCK_TYPES = [
  "heading", "paragraph", "image", "file", "table", "database", "kanban",
  "checklist", "code", "quote", "divider", "embed", "child_page", "page_link",
  "bulleted_list", "numbered_list", "callout", "signature", "drawing",
] as const;

/**
 * A signature's signer and time are stamped by the server from the
 * authenticated user — never trusted from the client — so a signature block
 * can't be forged in someone else's name. Any edit re-stamps it.
 */
function stampSignature(type: string, content: Record<string, unknown>, email: string): Record<string, unknown> {
  if (type !== "signature") return content;
  return { ...content, signed_by: email, signed_at: new Date().toISOString() };
}

/** Columns returned for a block, including authorship (resolved to emails for display). */
const BLOCK_COLS = `id, parent_id, type, content, position, created_at, updated_at,
  (SELECT email FROM users WHERE id = created_by) AS created_by_email,
  (SELECT email FROM users WHERE id = updated_by) AS updated_by_email`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BlockCtx {
  page_id: string;
  workspace_id: string;
}

async function blockCtx(app: FastifyInstance, blockId: string): Promise<BlockCtx | null> {
  const rows = await query<BlockCtx>(
    app.db,
    "SELECT b.page_id, p.workspace_id FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.id = $1",
    [blockId],
  );
  return rows[0] ?? null;
}

/** Keep page_links in sync when a block references another page. */
async function syncLink(app: FastifyInstance, fromPageId: string, content: Record<string, unknown>): Promise<void> {
  const target = content.pageId;
  if (typeof target === "string" && UUID_RE.test(target) && target !== fromPageId) {
    await query(
      app.db,
      "INSERT INTO page_links (from_page_id, to_page_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [fromPageId, target],
    );
  }
}

export async function registerBlockRoutes(app: FastifyInstance): Promise<void> {
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
    body.content = stampSignature(body.type, body.content, request.user!.email);

    const rows = await query(
      app.db,
      `INSERT INTO blocks (page_id, parent_id, type, content, position, created_by, updated_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'n'),$6,$6) RETURNING ${BLOCK_COLS}`,
      [pageId, body.parent_id ?? null, body.type, JSON.stringify(body.content), body.position ?? null, request.user!.id],
    );
    const block = rows[0]!;
    await syncLink(app, pageId, body.content);

    const ctx = await blockCtx(app, (block as { id: string }).id);
    if (ctx) app.hub.publish(ctx.workspace_id, { type: "block.created", pageId, block, by: request.user!.email });
    return reply.code(201).send({ block });
  });

  app.patch("/api/blocks/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        content: z.record(z.unknown()).optional(),
        position: z.string().max(64).optional(),
        type: z.enum(BLOCK_TYPES).optional(),
      })
      .parse(request.body);
    const ctx = await blockCtx(app, id);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await pageRole(app.db, request.user!.id, ctx.page_id), "page:update");
    if (body.content || body.type) {
      const type = body.type ?? (await query<{ type: string }>(app.db, "SELECT type FROM blocks WHERE id = $1", [id]))[0]?.type ?? "";
      if (type === "signature") {
        const current = body.content
          ?? (await query<{ content: Record<string, unknown> }>(app.db, "SELECT content FROM blocks WHERE id = $1", [id]))[0]?.content
          ?? {};
        body.content = stampSignature(type, current, request.user!.email);
      }
    }

    const rows = await query(
      app.db,
      `UPDATE blocks SET content = COALESCE($2, content), position = COALESCE($3, position),
              type = COALESCE($4, type), updated_by = $5, updated_at = now()
        WHERE id = $1 RETURNING ${BLOCK_COLS}`,
      [id, body.content ? JSON.stringify(body.content) : null, body.position ?? null, body.type ?? null, request.user!.id],
    );
    if (body.content) await syncLink(app, ctx.page_id, body.content);
    const block = rows[0]!;
    app.hub.publish(ctx.workspace_id, { type: "block.updated", pageId: ctx.page_id, block, by: request.user!.email });
    return reply.send({ block });
  });

  app.delete("/api/blocks/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ctx = await blockCtx(app, id);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await pageRole(app.db, request.user!.id, ctx.page_id), "page:update");
    await query(app.db, "DELETE FROM blocks WHERE id = $1", [id]);
    app.hub.publish(ctx.workspace_id, { type: "block.deleted", pageId: ctx.page_id, blockId: id, by: request.user!.email });
    return reply.code(204).send();
  });
}
