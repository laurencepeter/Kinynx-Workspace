import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgIdForWorkspace, workspaceRole } from "../access.js";
import { aggregate, evaluateFormula } from "../database/compute.js";

/** Heuristic: a value that reads as "done"/true marks a task complete. */
function looksComplete(values: Record<string, unknown>): boolean {
  return Object.values(values).some((v) => v === true || String(v).toLowerCase() === "done" || String(v).toLowerCase() === "complete");
}

/**
 * Flexible databases power project management: records are first-class rows with
 * typed properties. A "status" is a select property whose options carry colors;
 * "progress" is a number property. The /report endpoint turns these into
 * statistics (counts per status, progress rollups) for dashboards.
 */
const PROPERTY_TYPES = [
  "text", "number", "date", "date_range", "checkbox", "select", "multi_select",
  "person", "url", "email", "file", "formula", "relation", "rollup",
  "created_time", "updated_time",
] as const;

const VIEW_TYPES = ["table", "board", "calendar", "gallery", "list", "timeline"] as const;

interface PropRow {
  id: string;
  name: string;
  type: string;
  config: { expression?: string; via?: string; target?: string; agg?: string };
}

/** Attach computed formula/rollup values to each record. */
async function computeRecords(
  app: FastifyInstance,
  databaseId: string,
  records: Array<{ id: string; values: Record<string, unknown> }>,
): Promise<Array<{ id: string; values: Record<string, unknown>; computed: Record<string, number> }>> {
  const props = await query<PropRow>(app.db, "SELECT id, name, type, config FROM database_properties WHERE database_id=$1", [databaseId]);
  const nameToId = new Map(props.map((p) => [p.name, p.id]));
  const rollups = props.filter((p) => p.type === "rollup" && p.config.via && p.config.target);

  // Precompute rollups: relation property → { fromRecordId → [target values] }.
  const rollupValues = new Map<string, Map<string, number>>();
  for (const rp of rollups) {
    const rel = await query<{ from_record_id: string; values: Record<string, unknown> }>(
      app.db,
      `SELECT rr.from_record_id, dr.values
         FROM record_relations rr JOIN database_records dr ON dr.id = rr.to_record_id
        WHERE rr.property_id = $1`,
      [rp.config.via],
    );
    const grouped = new Map<string, number[]>();
    for (const r of rel) {
      const list = grouped.get(r.from_record_id) ?? [];
      list.push(Number(r.values[rp.config.target!]));
      grouped.set(r.from_record_id, list);
    }
    const perRecord = new Map<string, number>();
    for (const [rid, list] of grouped) perRecord.set(rid, aggregate(list, rp.config.agg ?? "count"));
    rollupValues.set(rp.id, perRecord);
  }

  const formulas = props.filter((p) => p.type === "formula" && p.config.expression);

  return records.map((rec) => {
    const computed: Record<string, number> = {};
    for (const rp of rollups) computed[rp.id] = rollupValues.get(rp.id)?.get(rec.id) ?? aggregate([], rp.config.agg ?? "count");
    for (const fp of formulas) {
      computed[fp.id] = evaluateFormula(fp.config.expression!, (name) => {
        const pid = nameToId.get(name);
        if (!pid) return 0;
        if (computed[pid] !== undefined) return computed[pid]; // reference a rollup result
        return Number(rec.values[pid]);
      });
    }
    return { ...rec, computed };
  });
}

export async function registerDatabaseRoutes(app: FastifyInstance): Promise<void> {
  const wsRole = (userId: string, wsId: string) => workspaceRole(app.db, userId, wsId);

  async function dbWorkspace(id: string): Promise<string | null> {
    const r = await query<{ workspace_id: string }>(app.db, "SELECT workspace_id FROM databases WHERE id=$1", [id]);
    return r[0]?.workspace_id ?? null;
  }
  async function recordDb(id: string): Promise<{ database_id: string; workspace_id: string } | null> {
    const r = await query<{ database_id: string; workspace_id: string }>(
      app.db,
      "SELECT r.database_id, d.workspace_id FROM database_records r JOIN databases d ON d.id=r.database_id WHERE r.id=$1",
      [id],
    );
    return r[0] ?? null;
  }

  app.get("/api/workspaces/:workspaceId/databases", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    assertCan(await wsRole(request.user!.id, workspaceId), "record:read");
    const rows = await query(app.db, "SELECT id, name, page_id, created_at FROM databases WHERE workspace_id=$1 ORDER BY created_at", [workspaceId]);
    return reply.send({ databases: rows });
  });

  app.post("/api/workspaces/:workspaceId/databases", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = z.object({ name: z.string().min(1).max(160), page_id: z.string().uuid().optional() }).parse(request.body);
    assertCan(await wsRole(request.user!.id, workspaceId), "record:create");
    const db = (await query(app.db, "INSERT INTO databases (workspace_id, name, page_id) VALUES ($1,$2,$3) RETURNING id, name, page_id", [workspaceId, body.name, body.page_id ?? null]))[0];
    // Every database gets a default table view.
    await query(app.db, "INSERT INTO database_views (database_id, name, type) VALUES ($1,'Table','table')", [(db as { id: string }).id]);
    return reply.code(201).send({ database: db });
  });

  app.get("/api/databases/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");
    const database = (await query(app.db, "SELECT id, name, page_id FROM databases WHERE id=$1", [id]))[0];
    const properties = await query(app.db, "SELECT id, name, type, config, position FROM database_properties WHERE database_id=$1 ORDER BY position", [id]);
    const views = await query(app.db, "SELECT id, name, type, config FROM database_views WHERE database_id=$1 ORDER BY position", [id]);
    return reply.send({ database, properties, views });
  });

  app.post("/api/databases/:id/properties", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ name: z.string().min(1).max(120), type: z.enum(PROPERTY_TYPES), config: z.record(z.unknown()).default({}) }).parse(request.body);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:update");
    const row = (await query(app.db, "INSERT INTO database_properties (database_id, name, type, config) VALUES ($1,$2,$3,$4) RETURNING id, name, type, config", [id, body.name, body.type, JSON.stringify(body.config)]))[0];
    return reply.code(201).send({ property: row });
  });

  app.post("/api/databases/:id/views", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ name: z.string().min(1).max(120), type: z.enum(VIEW_TYPES), config: z.record(z.unknown()).default({}) }).parse(request.body);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:update");
    const row = (await query(app.db, "INSERT INTO database_views (database_id, name, type, config) VALUES ($1,$2,$3,$4) RETURNING id, name, type, config", [id, body.name, body.type, JSON.stringify(body.config)]))[0];
    return reply.code(201).send({ view: row });
  });

  app.get("/api/databases/:id/records", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = z.object({ compute: z.coerce.boolean().optional() }).parse(request.query);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");
    const rows = await query<{ id: string; values: Record<string, unknown> }>(
      app.db,
      "SELECT id, values, position, created_at, updated_at FROM database_records WHERE database_id=$1 ORDER BY position, created_at",
      [id],
    );
    if (!q.compute) return reply.send({ records: rows });
    return reply.send({ records: await computeRecords(app, id, rows) });
  });

  app.post("/api/databases/:id/records", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ values: z.record(z.unknown()).default({}) }).parse(request.body);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:create");
    const row = (await query(app.db, "INSERT INTO database_records (database_id, values, created_by) VALUES ($1,$2,$3) RETURNING id, values, created_at", [id, JSON.stringify(body.values), request.user!.id]))[0] as { id: string };
    app.hub.publish(wsId, { type: "block.created", pageId: id, block: row, by: request.user!.email });
    const orgId = await orgIdForWorkspace(app.db, wsId);
    if (orgId) {
      app.events.publish({ type: "record.created", workspaceId: wsId, organizationId: orgId, actorEmail: request.user!.email, data: { database_id: id, record_id: row.id, ...body.values } });
    }
    return reply.code(201).send({ record: row });
  });

  app.patch("/api/records/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ values: z.record(z.unknown()) }).parse(request.body);
    const ctx = await recordDb(id);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, ctx.workspace_id), "record:update");
    // Merge values (partial update) at the JSONB level.
    const row = (await query(app.db, "UPDATE database_records SET values = values || $2::jsonb, updated_at = now() WHERE id=$1 RETURNING id, values, updated_at", [id, JSON.stringify(body.values)]))[0] as { id: string; values: Record<string, unknown> };
    app.hub.publish(ctx.workspace_id, { type: "block.updated", pageId: ctx.database_id, block: row, by: request.user!.email });
    const orgId = await orgIdForWorkspace(app.db, ctx.workspace_id);
    if (orgId) {
      const data = { database_id: ctx.database_id, record_id: id, ...row.values };
      app.events.publish({ type: "record.updated", workspaceId: ctx.workspace_id, organizationId: orgId, actorEmail: request.user!.email, data });
      if (looksComplete(body.values)) {
        app.events.publish({ type: "task.completed", workspaceId: ctx.workspace_id, organizationId: orgId, actorEmail: request.user!.email, data });
      }
    }
    return reply.send({ record: row });
  });

  app.delete("/api/records/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ctx = await recordDb(id);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, ctx.workspace_id), "record:delete");
    await query(app.db, "DELETE FROM database_records WHERE id=$1", [id]);
    app.hub.publish(ctx.workspace_id, { type: "block.deleted", pageId: ctx.database_id, blockId: id, by: request.user!.email });
    return reply.code(204).send();
  });

  // Statistics / report: counts grouped by a select property (with colors) and
  // a rollup over a number property. Drives project dashboards and reports.
  app.get("/api/databases/:id/report", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = z.object({ group_by: z.string().uuid().optional(), progress: z.string().uuid().optional() }).parse(request.query);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");

    const properties = await query<{ id: string; name: string; type: string; config: { options?: Array<{ name: string; color?: string }> } }>(
      app.db,
      "SELECT id, name, type, config FROM database_properties WHERE database_id=$1",
      [id],
    );
    const records = await query<{ values: Record<string, unknown> }>(app.db, "SELECT values FROM database_records WHERE database_id=$1", [id]);

    const groupProp = q.group_by ? properties.find((p) => p.id === q.group_by) : properties.find((p) => p.type === "select");
    const progressProp = q.progress ? properties.find((p) => p.id === q.progress) : properties.find((p) => p.type === "number");

    const byStatus: Record<string, number> = {};
    let sum = 0;
    let progressCount = 0;
    for (const rec of records) {
      if (groupProp) {
        const v = String(rec.values[groupProp.id] ?? "—");
        byStatus[v] = (byStatus[v] ?? 0) + 1;
      }
      if (progressProp) {
        const n = Number(rec.values[progressProp.id]);
        if (!Number.isNaN(n)) { sum += n; progressCount++; }
      }
    }

    const colorFor = (name: string) =>
      groupProp?.config.options?.find((o) => o.name === name)?.color ?? null;

    return reply.send({
      total: records.length,
      group_by: groupProp ? { id: groupProp.id, name: groupProp.name } : null,
      by_status: Object.entries(byStatus).map(([name, count]) => ({ name, count, color: colorFor(name) })),
      progress: progressProp
        ? { id: progressProp.id, name: progressProp.name, sum, count: progressCount, avg: progressCount ? +(sum / progressCount).toFixed(2) : 0 }
        : null,
    });
  });
}
