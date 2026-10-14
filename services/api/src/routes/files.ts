import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { withinLimit } from "@kinynx/shared";
import { query } from "../db/pool.js";
import { workspaceRole } from "../access.js";
import { makeStorageKey } from "../storage/index.js";

/**
 * File attachments. Metadata lives in Postgres (`files`); bytes live in object
 * storage via the StorageDriver. Two-step: create metadata → upload bytes.
 * With an S3 driver, presigned URLs let clients upload/download directly.
 */
interface FileCtx {
  id: string;
  workspace_id: string | null;
  organization_id: string;
  storage_key: string;
  filename: string;
  content_type: string;
}

async function fileCtx(db: pg.Pool, id: string): Promise<FileCtx | null> {
  const rows = await query<FileCtx>(
    db,
    "SELECT id, workspace_id, organization_id, storage_key, filename, content_type FROM files WHERE id=$1",
    [id],
  );
  return rows[0] ?? null;
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  const maxFile = app.entitlements.limits.max_file_size_bytes;

  // Create file metadata + get an upload target.
  app.post("/api/workspaces/:workspaceId/files", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ filename: z.string().min(1).max(400), content_type: z.string().max(160).default("application/octet-stream"), size_bytes: z.number().int().min(0) })
      .parse(request.body);
    assertCan(await workspaceRole(app.db, request.user!.id, workspaceId), "page:create");

    if (!withinLimit(maxFile, body.size_bytes)) {
      return reply.code(413).send({ error: `file exceeds max size (${maxFile} bytes)`, edition: app.entitlements.edition });
    }

    const org = (await query<{ organization_id: string }>(app.db, "SELECT organization_id FROM workspaces WHERE id=$1", [workspaceId]))[0];
    if (!org) return reply.code(404).send({ error: "workspace not found" });

    const inserted = (
      await query<{ id: string }>(
        app.db,
        `INSERT INTO files (organization_id, workspace_id, storage_key, filename, content_type, size_bytes, uploaded_by, status)
         VALUES ($1,$2,'',$3,$4,$5,$6,'pending') RETURNING id`,
        [org.organization_id, workspaceId, body.filename, body.content_type, body.size_bytes, request.user!.id],
      )
    )[0]!;
    const key = makeStorageKey(org.organization_id, inserted.id, body.filename);
    await query(app.db, "UPDATE files SET storage_key=$2 WHERE id=$1", [inserted.id, key]);

    // Presigned direct upload when the driver supports it (S3/MinIO/R2).
    const upload = app.storage.presignPut
      ? { method: "PUT", url: await app.storage.presignPut(key, body.content_type), direct: true }
      : { method: "PUT", url: `${app.config.PUBLIC_APP_URL}/api/files/${inserted.id}/content`, direct: false };

    return reply.code(201).send({ file: { id: inserted.id, filename: body.filename, content_type: body.content_type, size_bytes: body.size_bytes }, upload });
  });

  // Direct upload of bytes (used when not presigning; body is octet-stream).
  app.put(
    "/api/files/:id/content",
    {
      preHandler: app.authenticate,
      bodyLimit: maxFile > 0 ? maxFile : 200 * 1024 * 1024,
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const ctx = await fileCtx(app.db, id);
      if (!ctx || !ctx.workspace_id) return reply.code(404).send({ error: "not found" });
      assertCan(await workspaceRole(app.db, request.user!.id, ctx.workspace_id), "page:create");

      const buf = request.body as Buffer;
      if (!Buffer.isBuffer(buf)) return reply.code(400).send({ error: "send raw bytes as application/octet-stream" });
      await app.storage.putObject(ctx.storage_key, buf, ctx.content_type);
      await query(app.db, "UPDATE files SET status='ready', size_bytes=$2 WHERE id=$1", [id, buf.length]);
      return reply.send({ ok: true, size_bytes: buf.length });
    },
  );

  // Metadata + a download URL.
  app.get("/api/files/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ctx = await fileCtx(app.db, id);
    if (!ctx || !ctx.workspace_id) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, ctx.workspace_id), "page:read");
    const download = app.storage.presignGet
      ? await app.storage.presignGet(ctx.storage_key)
      : `${app.config.PUBLIC_APP_URL}/api/files/${id}/content`;
    return reply.send({ file: { id: ctx.id, filename: ctx.filename, content_type: ctx.content_type }, download });
  });

  // Stream bytes back (used with the local driver).
  app.get("/api/files/:id/content", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ctx = await fileCtx(app.db, id);
    if (!ctx || !ctx.workspace_id) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, ctx.workspace_id), "page:read");
    const obj = await app.storage.getObject(ctx.storage_key);
    if (!obj) return reply.code(404).send({ error: "object not found" });
    reply.header("content-type", ctx.content_type);
    reply.header("content-disposition", `inline; filename="${ctx.filename.replace(/"/g, "")}"`);
    return reply.send(obj.body);
  });

  app.delete("/api/files/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ctx = await fileCtx(app.db, id);
    if (!ctx || !ctx.workspace_id) return reply.code(404).send({ error: "not found" });
    assertCan(await workspaceRole(app.db, request.user!.id, ctx.workspace_id), "page:update");
    await app.storage.deleteObject(ctx.storage_key);
    await query(app.db, "DELETE FROM files WHERE id=$1", [id]);
    return reply.code(204).send();
  });
}
