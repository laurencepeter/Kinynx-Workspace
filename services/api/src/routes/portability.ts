import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { pageRole, workspaceRole } from "../access.js";

/**
 * Portable import/export. Export produces a self-contained JSON tree (a page and
 * all its descendants, with their blocks) that can be re-imported into any
 * workspace — the basis of the .template.zip format (see docs/TEMPLATE_SPEC.md).
 * Nothing here depends on a marketplace server.
 */
export interface PortablePage {
  title: string;
  icon?: string | null;
  color?: string | null;
  blocks?: Array<{ type: string; content?: unknown; position?: string }>;
  children?: PortablePage[];
}

export async function exportSubtree(db: pg.Pool, pageId: string): Promise<PortablePage> {
  const page = (await query<{ title: string; icon: string | null; color: string | null }>(
    db,
    "SELECT title, icon, color FROM pages WHERE id=$1",
    [pageId],
  ))[0]!;
  const blocks = await query<{ type: string; content: unknown; position: string }>(
    db,
    "SELECT type, content, position FROM blocks WHERE page_id=$1 ORDER BY position, created_at",
    [pageId],
  );
  const childIds = await query<{ id: string }>(
    db,
    "SELECT id FROM pages WHERE parent_id=$1 AND archived_at IS NULL ORDER BY position, created_at",
    [pageId],
  );
  const children: PortablePage[] = [];
  for (const c of childIds) children.push(await exportSubtree(db, c.id));
  return { title: page.title, icon: page.icon, color: page.color, blocks, children };
}

export const portablePageSchema: z.ZodType<PortablePage> = z.lazy(() =>
  z.object({
    title: z.string().max(400),
    icon: z.string().nullable().default(null),
    color: z.string().nullable().default(null),
    blocks: z
      .array(z.object({ type: z.string().max(40), content: z.unknown().default({}), position: z.string().max(64).default("n") }))
      .default([]),
    children: z.array(portablePageSchema).default([]),
  }),
);

export async function importSubtree(
  client: pg.PoolClient,
  workspaceId: string,
  parentId: string | null,
  node: PortablePage,
  userId: string,
): Promise<string> {
  const page = (
    await client.query(
      "INSERT INTO pages (workspace_id, parent_id, title, icon, color, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [workspaceId, parentId, node.title, node.icon, node.color, userId],
    )
  ).rows[0] as { id: string };
  for (const b of node.blocks ?? []) {
    await client.query("INSERT INTO blocks (page_id, type, content, position) VALUES ($1,$2,$3,$4)", [
      page.id,
      b.type,
      JSON.stringify(b.content ?? {}),
      b.position ?? "n",
    ]);
  }
  for (const child of node.children ?? []) await importSubtree(client, workspaceId, page.id, child, userId);
  return page.id;
}

export async function registerPortabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/pages/:id/export", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:read");
    const tree = await exportSubtree(app.db, id);
    return reply.send({ format: "kinynx.page/1.0", exported_at: new Date().toISOString(), page: tree });
  });

  app.post("/api/workspaces/:workspaceId/import", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = z.object({ page: portablePageSchema, parent_id: z.string().uuid().optional() }).parse(request.body);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "page:create");

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const rootId = await importSubtree(client, workspaceId, body.parent_id ?? null, body.page, request.user!.id);
      await client.query("COMMIT");
      return reply.code(201).send({ page_id: rootId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}
