import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgRole, pageRole } from "../access.js";

interface SnapshotBlock {
  id: string;
  parent_id: string | null;
  type: string;
  content: unknown;
  position: string;
}
interface Snapshot {
  title: string;
  blocks: SnapshotBlock[];
}

async function pageWorkspace(app: FastifyInstance, pageId: string): Promise<string | null> {
  const r = await query<{ workspace_id: string }>(app.db, "SELECT workspace_id FROM pages WHERE id=$1", [pageId]);
  return r[0]?.workspace_id ?? null;
}

async function buildSnapshot(db: pg.Pool, pageId: string): Promise<Snapshot> {
  const page = (await query<{ title: string }>(db, "SELECT title FROM pages WHERE id=$1", [pageId]))[0];
  const blocks = await query<SnapshotBlock>(
    db,
    "SELECT id, parent_id, type, content, position FROM blocks WHERE page_id=$1 ORDER BY position, created_at",
    [pageId],
  );
  return { title: page?.title ?? "Untitled", blocks };
}

async function saveVersion(db: pg.Pool, pageId: string, userId: string): Promise<number> {
  const snapshot = await buildSnapshot(db, pageId);
  const next =
    Number(
      (await query<{ v: number | null }>(db, "SELECT max(version) v FROM page_versions WHERE page_id=$1", [pageId]))[0]?.v ?? 0,
    ) + 1;
  await query(
    db,
    "INSERT INTO page_versions (page_id, version, title, snapshot, created_by) VALUES ($1,$2,$3,$4,$5)",
    [pageId, next, snapshot.title, JSON.stringify(snapshot), userId],
  );
  return next;
}

export async function registerHistoryRoutes(app: FastifyInstance): Promise<void> {
  // Create a version snapshot (manual backup / checkpoint).
  app.post("/api/pages/:id/versions", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:update");
    const version = await saveVersion(app.db, id, request.user!.id);
    return reply.code(201).send({ version });
  });

  app.get("/api/pages/:id/versions", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:read");
    const rows = await query(
      app.db,
      `SELECT v.version, v.title, v.created_at, u.email AS created_by
         FROM page_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.page_id=$1 ORDER BY v.version DESC`,
      [id],
    );
    return reply.send({ versions: rows });
  });

  // Restore a version. The current state is snapshotted first, so restore is
  // itself reversible (nothing is lost).
  app.post("/api/pages/:id/versions/:version/restore", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, version } = z.object({ id: z.string().uuid(), version: z.coerce.number().int() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:update");

    const snapRow = (await query<{ snapshot: Snapshot }>(app.db, "SELECT snapshot FROM page_versions WHERE page_id=$1 AND version=$2", [id, version]))[0];
    if (!snapRow) return reply.code(404).send({ error: "version not found" });
    const snap = snapRow.snapshot;

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      // Checkpoint current state before overwriting.
      await saveVersion(app.db, id, request.user!.id);
      await client.query("DELETE FROM blocks WHERE page_id=$1", [id]);
      // Remap old block ids → new ids so parent relationships survive.
      const idMap = new Map<string, string>();
      for (const b of snap.blocks) idMap.set(b.id, randomUUID());
      for (const b of snap.blocks) {
        await client.query(
          "INSERT INTO blocks (id, page_id, parent_id, type, content, position) VALUES ($1,$2,$3,$4,$5,$6)",
          [idMap.get(b.id), id, b.parent_id ? idMap.get(b.parent_id) ?? null : null, b.type, JSON.stringify(b.content), b.position],
        );
      }
      await client.query("UPDATE pages SET title=$2 WHERE id=$1", [id, snap.title]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const wsId = await pageWorkspace(app, id);
    if (wsId) app.hub.publish(wsId, { type: "page.updated", pageId: id, by: request.user!.email });
    return reply.send({ ok: true, restored_from: version });
  });

  // Backlinks: which pages link to this page (linked references).
  app.get("/api/pages/:id/backlinks", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    assertCan(await pageRole(app.db, request.user!.id, id), "page:read");
    const rows = await query(
      app.db,
      `SELECT p.id, p.title, p.icon FROM page_links l JOIN pages p ON p.id = l.from_page_id
        WHERE l.to_page_id = $1 AND p.archived_at IS NULL ORDER BY p.title`,
      [id],
    );
    return reply.send({ backlinks: rows });
  });

  // Audit trail (basic read for org admins; Enterprise adds retention/export/legal hold).
  app.get("/api/organizations/:orgId/audit", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:view_audit_logs");
    const rows = await query(
      app.db,
      `SELECT a.action, a.target_type, a.target_id, a.created_at, u.email AS actor
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT $2`,
      [orgId, q.limit],
    );
    return reply.send({ events: rows });
  });
}
