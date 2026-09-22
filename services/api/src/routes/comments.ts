import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { assertCan, can } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { workspaceRole } from "../access.js";

/**
 * Comments on pages, blocks, and database records, with @mentions that create
 * notifications. Threaded via parent_id. Comment access follows the target's
 * workspace permissions (commenter role to write, viewer to read).
 */
type TargetType = "page" | "block" | "record";

async function resolveWorkspace(db: pg.Pool, type: TargetType, id: string): Promise<{ workspaceId: string; orgId: string } | null> {
  let sql: string;
  if (type === "page") {
    sql = `SELECT w.id AS ws, w.organization_id AS org FROM pages p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = $1`;
  } else if (type === "block") {
    sql = `SELECT w.id AS ws, w.organization_id AS org FROM blocks b JOIN pages p ON p.id = b.page_id JOIN workspaces w ON w.id = p.workspace_id WHERE b.id = $1`;
  } else {
    sql = `SELECT w.id AS ws, w.organization_id AS org FROM database_records r JOIN databases d ON d.id = r.database_id JOIN workspaces w ON w.id = d.workspace_id WHERE r.id = $1`;
  }
  const rows = await query<{ ws: string; org: string }>(db, sql, [id]);
  return rows[0] ? { workspaceId: rows[0].ws, orgId: rows[0].org } : null;
}

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/comments", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        target_type: z.enum(["page", "block", "record"]),
        target_id: z.string().uuid(),
        body: z.string().min(1).max(10_000),
        parent_id: z.string().uuid().optional(),
        mentions: z.array(z.string().uuid()).max(50).default([]),
      })
      .parse(request.body);

    const ctx = await resolveWorkspace(app.db, body.target_type, body.target_id);
    if (!ctx) return reply.code(404).send({ error: "target not found" });
    const role = await workspaceRole(app.db, request.user!.id, ctx.workspaceId);
    assertCan(role, "page:comment");

    // Only mention users who are actually members of the org (no data leak).
    const validMentions =
      body.mentions.length === 0
        ? []
        : (
            await query<{ user_id: string }>(
              app.db,
              "SELECT user_id FROM organization_members WHERE organization_id = $1 AND user_id = ANY($2::uuid[])",
              [ctx.orgId, body.mentions],
            )
          ).map((r) => r.user_id);

    const comment = (
      await query(
        app.db,
        `INSERT INTO comments (workspace_id, target_type, target_id, parent_id, author_id, body, mentions)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, target_type, target_id, parent_id, author_id, body, mentions, created_at`,
        [ctx.workspaceId, body.target_type, body.target_id, body.parent_id ?? null, request.user!.id, body.body, validMentions],
      )
    )[0] as { id: string };

    // Notify mentioned users (except self).
    for (const uid of validMentions) {
      if (uid === request.user!.id) continue;
      await query(
        app.db,
        `INSERT INTO notifications (user_id, organization_id, type, actor_id, target_type, target_id, data)
         VALUES ($1,$2,'mention',$3,$4,$5,$6)`,
        [uid, ctx.orgId, request.user!.id, body.target_type, body.target_id, JSON.stringify({ comment_id: comment.id, excerpt: body.body.slice(0, 140) })],
      );
    }
    // Notify the parent comment's author on a reply.
    if (body.parent_id) {
      const parent = (await query<{ author_id: string | null }>(app.db, "SELECT author_id FROM comments WHERE id=$1", [body.parent_id]))[0];
      if (parent?.author_id && parent.author_id !== request.user!.id && !validMentions.includes(parent.author_id)) {
        await query(
          app.db,
          `INSERT INTO notifications (user_id, organization_id, type, actor_id, target_type, target_id, data)
           VALUES ($1,$2,'comment',$3,$4,$5,$6)`,
          [parent.author_id, ctx.orgId, request.user!.id, body.target_type, body.target_id, JSON.stringify({ comment_id: comment.id })],
        );
      }
    }

    app.hub.publish(ctx.workspaceId, { type: "comment.created", targetType: body.target_type, targetId: body.target_id, comment, by: request.user!.email });
    app.events.publish({
      type: "comment.added",
      workspaceId: ctx.workspaceId,
      organizationId: ctx.orgId,
      actorEmail: request.user!.email,
      data: { target_type: body.target_type, target_id: body.target_id, comment_id: comment.id, excerpt: body.body.slice(0, 140) },
    });
    return reply.code(201).send({ comment });
  });

  app.get("/api/comments", { preHandler: app.authenticate }, async (request, reply) => {
    const q = z.object({ target_type: z.enum(["page", "block", "record"]), target_id: z.string().uuid() }).parse(request.query);
    const ctx = await resolveWorkspace(app.db, q.target_type, q.target_id);
    if (!ctx) return reply.code(404).send({ error: "target not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, ctx.workspaceId), "page:read");
    const rows = await query(
      app.db,
      `SELECT c.id, c.parent_id, c.body, c.mentions, c.resolved_at, c.created_at, u.email AS author
         FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.target_type = $1 AND c.target_id = $2 ORDER BY c.created_at`,
      [q.target_type, q.target_id],
    );
    return reply.send({ comments: rows });
  });

  app.post("/api/comments/:id/resolve", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const c = (await query<{ workspace_id: string }>(app.db, "SELECT workspace_id FROM comments WHERE id=$1", [id]))[0];
    if (!c) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, c.workspace_id), "page:comment");
    await query(app.db, "UPDATE comments SET resolved_at = now() WHERE id=$1", [id]);
    return reply.send({ ok: true });
  });

  app.delete("/api/comments/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const c = (await query<{ workspace_id: string; author_id: string | null }>(app.db, "SELECT workspace_id, author_id FROM comments WHERE id=$1", [id]))[0];
    if (!c) return reply.code(404).send({ error: "not found" });
    const role = await workspaceRole(app.db, request.user!.id, c.workspace_id);
    // Author can delete own comment; otherwise needs editor+.
    if (c.author_id !== request.user!.id) assertCan(role, "page:update");
    else assertCan(role, "page:comment");
    await query(app.db, "DELETE FROM comments WHERE id=$1", [id]);
    return reply.code(204).send();
  });
}
