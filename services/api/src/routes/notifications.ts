import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";

/** Per-user notification inbox (mentions, replies, invites, assignments). */
export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notifications", { preHandler: app.authenticate }, async (request, reply) => {
    const q = z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await query(
      app.db,
      `SELECT n.id, n.type, n.target_type, n.target_id, n.data, n.read_at, n.created_at, u.email AS actor
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
        WHERE n.user_id = $1 ${q.unread ? "AND n.read_at IS NULL" : ""}
        ORDER BY n.created_at DESC LIMIT $2`,
      [request.user!.id, q.limit],
    );
    return reply.send({ notifications: rows });
  });

  app.get("/api/notifications/unread-count", { preHandler: app.authenticate }, async (request) => {
    const rows = await query<{ n: string }>(app.db, "SELECT count(*) n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [request.user!.id]);
    return { unread: Number(rows[0]!.n) };
  });

  app.post("/api/notifications/:id/read", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await query(app.db, "UPDATE notifications SET read_at = now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL", [id, request.user!.id]);
    return reply.send({ ok: true });
  });

  app.post("/api/notifications/read-all", { preHandler: app.authenticate }, async (request, reply) => {
    await query(app.db, "UPDATE notifications SET read_at = now() WHERE user_id=$1 AND read_at IS NULL", [request.user!.id]);
    return reply.send({ ok: true });
  });
}
