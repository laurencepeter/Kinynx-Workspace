import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { orgIdForWorkspace, workspaceRole } from "../access.js";
import { aggregate, evaluateFormula } from "../database/compute.js";
import { ChartQuerySchema, csvCell, runChartQuery, type PropertyInfo, type RecordInput } from "../analytics/query.js";
import { categoryOf, checkTransition, computeProgress, WorkflowSchema, type Workflow } from "../analytics/workflow.js";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Property types whose values the server derives; clients cannot write them. */
const COMPUTED_TYPES = new Set(["formula", "rollup", "created_time", "updated_time"]);

const VIEW_TYPES = ["table", "board", "calendar", "gallery", "list", "timeline"] as const;

interface PropRow {
  id: string;
  name: string;
  type: string;
  config: { expression?: string; via?: string; target?: string; agg?: string };
}

/** Attach computed formula/rollup values to each record. */
export async function computeRecords(
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

/**
 * Load a database's properties and (computed) records for analytics. Callers
 * MUST have authorized `record:read` on the owning workspace first.
 */
export async function loadDataset(app: FastifyInstance, databaseId: string): Promise<{ properties: PropertyInfo[]; records: RecordInput[] }> {
  const properties = await query<PropertyInfo>(app.db, "SELECT id, name, type, config FROM database_properties WHERE database_id=$1 ORDER BY position, created_at", [databaseId]);
  const rows = await query<{ id: string; values: Record<string, unknown>; created_at: Date; updated_at: Date }>(
    app.db,
    "SELECT id, values, created_at, updated_at FROM database_records WHERE database_id=$1 ORDER BY position, created_at",
    [databaseId],
  );
  const computed = await computeRecords(app, databaseId, rows);
  return { properties, records: computed.map((r, i) => ({ ...r, created_at: rows[i]!.created_at, updated_at: rows[i]!.updated_at })) };
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

  // Update a property (e.g. append a select option / rename).
  app.patch("/api/databases/properties/:propId", { preHandler: app.authenticate }, async (request, reply) => {
    const { propId } = z.object({ propId: z.string().uuid() }).parse(request.params);
    const body = z.object({ name: z.string().min(1).max(120).optional(), config: z.record(z.unknown()).optional() }).parse(request.body);
    const ctx = (
      await query<{ workspace_id: string }>(
        app.db,
        "SELECT d.workspace_id FROM database_properties p JOIN databases d ON d.id = p.database_id WHERE p.id=$1",
        [propId],
      )
    )[0];
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, ctx.workspace_id), "record:update");
    const row = (
      await query(
        app.db,
        "UPDATE database_properties SET name = COALESCE($2, name), config = COALESCE($3, config) WHERE id=$1 RETURNING id, name, type, config",
        [propId, body.name ?? null, body.config ? JSON.stringify(body.config) : null],
      )
    )[0];
    return reply.send({ property: row });
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

  interface WorkflowRow extends Workflow { id: string }
  const loadWorkflow = async (client: pg.Pool | pg.PoolClient, dbId: string, lock = false): Promise<WorkflowRow | null> =>
    (
      await client.query<WorkflowRow>(
        `SELECT id, status_property_id, due_property_id, stages, transitions, enforce FROM workflows WHERE database_id=$1${lock ? " FOR UPDATE" : ""}`,
        [dbId],
      )
    ).rows[0] ?? null;

  /** Reject value keys that are not this database's own (writable) properties. */
  async function assertOwnKeys(dbId: string, values: Record<string, unknown>): Promise<string | null> {
    const keys = Object.keys(values).filter((k) => k !== "title");
    if (keys.length === 0) return null;
    const rows = await query<{ id: string; type: string }>(app.db, "SELECT id, type FROM database_properties WHERE database_id=$1 AND id = ANY($2::uuid[])", [dbId, keys.filter((k) => UUID_RE.test(k))]);
    const writable = new Set(rows.filter((r) => !COMPUTED_TYPES.has(r.type)).map((r) => r.id));
    const bad = keys.find((k) => !writable.has(k));
    return bad ? `unknown or read-only property "${bad.slice(0, 60)}"` : null;
  }

  /**
   * Validate a stage move against the workflow inside the caller's transaction.
   * The workflow row is locked so concurrent moves serialise and WIP limits hold.
   */
  async function guardStage(client: pg.PoolClient, dbId: string, recordId: string | null, from: unknown, to: unknown) {
    const wf = await loadWorkflow(client, dbId, true);
    if (!wf || !wf.enforce || to === undefined || to === null || to === "") return { wf, error: null };
    const n = Number(
      (
        await client.query<{ n: string }>(
          "SELECT count(*) n FROM database_records WHERE database_id=$1 AND values->>$2 = $3 AND ($4::uuid IS NULL OR id <> $4)",
          [dbId, wf.status_property_id, String(to), recordId],
        )
      ).rows[0]!.n,
    );
    const res = checkTransition(wf, from === undefined || from === null ? null : String(from), String(to), n);
    return { wf, error: res.ok ? null : res };
  }

  async function logEvents(client: pg.PoolClient, rows: Array<[string, string, string, string | null, unknown, unknown, string]>) {
    for (const r of rows) {
      await client.query(
        "INSERT INTO record_events (database_id, record_id, kind, property_id, from_value, to_value, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [r[0], r[1], r[2], r[3], r[4] === undefined ? null : JSON.stringify(r[4]), r[5] === undefined ? null : JSON.stringify(r[5]), r[6]],
      );
    }
  }

  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  app.post("/api/databases/:id/records", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ values: z.record(z.unknown()).default({}) }).parse(request.body);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:create");
    const bad = await assertOwnKeys(id, body.values);
    if (bad) return reply.code(400).send({ error: bad });
    const result = await tx(async (c) => {
      const pre = await loadWorkflow(c, id);
      const g = pre ? await guardStage(c, id, null, null, body.values[pre.status_property_id]) : { wf: null, error: null };
      if (g.error) return { error: g.error };
      const row = (await c.query("INSERT INTO database_records (database_id, values, created_by) VALUES ($1,$2,$3) RETURNING id, values, created_at", [id, JSON.stringify(body.values), request.user!.id])).rows[0] as { id: string };
      await logEvents(c, [[id, row.id, "created", null, undefined, body.values, request.user!.id]]);
      return { row };
    });
    if ("error" in result && result.error) return reply.code(result.error.code).send({ error: result.error.error });
    const row = result.row!;
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
    const bad = await assertOwnKeys(ctx.database_id, body.values);
    if (bad) return reply.code(400).send({ error: bad });

    const result = await tx(async (c) => {
      const pre = await loadWorkflow(c, ctx.database_id);
      const old = (await c.query<{ values: Record<string, unknown> }>("SELECT values FROM database_records WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!old) return { missing: true as const };
      const statusId = pre?.status_property_id;
      const moving = statusId !== undefined && statusId in body.values && body.values[statusId] !== old.values[statusId];
      const g = moving ? await guardStage(c, ctx.database_id, id, old.values[statusId], body.values[statusId]) : { wf: pre, error: null };
      if (g.error) return { error: g.error };
      // Merge values (partial update) at the JSONB level.
      const row = (await c.query("UPDATE database_records SET values = values || $2::jsonb, updated_at = now() WHERE id=$1 RETURNING id, values, updated_at", [id, JSON.stringify(body.values)])).rows[0] as { id: string; values: Record<string, unknown> };
      const evs: Array<[string, string, string, string | null, unknown, unknown, string]> = [];
      for (const [k, v] of Object.entries(body.values)) {
        if (JSON.stringify(old.values[k]) === JSON.stringify(v)) continue;
        evs.push([ctx.database_id, id, k === statusId ? "stage_changed" : "updated", k === "title" ? null : k, old.values[k], v, request.user!.id]);
      }
      await logEvents(c, evs);
      const completed = moving && g.wf ? categoryOf(g.wf, body.values[statusId!]) === "done" && categoryOf(g.wf, old.values[statusId!]) !== "done" : null;
      return { row, completed };
    });
    if ("missing" in result) return reply.code(404).send({ error: "not found" });
    if ("error" in result && result.error) return reply.code(result.error.code).send({ error: result.error.error });
    const { row, completed } = result as { row: { id: string; values: Record<string, unknown> }; completed: boolean | null };
    app.hub.publish(ctx.workspace_id, { type: "block.updated", pageId: ctx.database_id, block: row, by: request.user!.email });
    const orgId = await orgIdForWorkspace(app.db, ctx.workspace_id);
    if (orgId) {
      const data = { database_id: ctx.database_id, record_id: id, ...row.values };
      app.events.publish({ type: "record.updated", workspaceId: ctx.workspace_id, organizationId: orgId, actorEmail: request.user!.email, data });
      // With a workflow, "done" is the stage category; otherwise fall back to the heuristic.
      if (completed ?? looksComplete(body.values)) {
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
    await tx(async (c) => {
      await c.query("DELETE FROM database_records WHERE id=$1", [id]);
      await logEvents(c, [[ctx.database_id, id, "deleted", null, undefined, undefined, request.user!.id]]);
    });
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

  // ── Structure management (rename/delete databases, properties, views) ─────
  app.patch("/api/databases/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(1).max(160) }).parse(request.body);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:update");
    const row = (await query(app.db, "UPDATE databases SET name=$2, updated_at=now() WHERE id=$1 RETURNING id, name, page_id", [id, body.name]))[0];
    return reply.send({ database: row });
  });

  // Deleting a whole database requires echoing its name back.
  app.delete("/api/databases/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(request.body ?? {});
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:delete");
    const db = (await query<{ name: string }>(app.db, "SELECT name FROM databases WHERE id=$1", [id]))[0]!;
    if (confirm !== db.name) return reply.code(400).send({ error: "confirmation does not match the database name" });
    await query(app.db, "DELETE FROM databases WHERE id=$1", [id]);
    return reply.code(204).send();
  });

  async function propWorkspace(propId: string) {
    return (await query<{ workspace_id: string; database_id: string }>(app.db, "SELECT d.workspace_id, p.database_id FROM database_properties p JOIN databases d ON d.id = p.database_id WHERE p.id=$1", [propId]))[0] ?? null;
  }

  app.delete("/api/databases/properties/:propId", { preHandler: app.authenticate }, async (request, reply) => {
    const { propId } = z.object({ propId: z.string().uuid() }).parse(request.params);
    const ctx = await propWorkspace(propId);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, ctx.workspace_id), "record:update");
    await tx(async (c) => {
      await c.query("DELETE FROM database_properties WHERE id=$1", [propId]);
      await c.query("UPDATE database_records SET values = values - $2::text WHERE database_id=$1 AND values ? $2::text", [ctx.database_id, propId]);
    });
    return reply.code(204).send();
  });

  async function viewWorkspace(viewId: string) {
    return (await query<{ workspace_id: string }>(app.db, "SELECT d.workspace_id FROM database_views v JOIN databases d ON d.id = v.database_id WHERE v.id=$1", [viewId]))[0] ?? null;
  }

  app.patch("/api/databases/views/:viewId", { preHandler: app.authenticate }, async (request, reply) => {
    const { viewId } = z.object({ viewId: z.string().uuid() }).parse(request.params);
    const body = z.object({ name: z.string().min(1).max(120).optional(), type: z.enum(VIEW_TYPES).optional(), config: z.record(z.unknown()).optional() }).parse(request.body);
    const ctx = await viewWorkspace(viewId);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, ctx.workspace_id), "record:update");
    const row = (await query(app.db, "UPDATE database_views SET name=COALESCE($2,name), type=COALESCE($3,type), config=COALESCE($4,config) WHERE id=$1 RETURNING id, name, type, config", [viewId, body.name ?? null, body.type ?? null, body.config ? JSON.stringify(body.config) : null]))[0];
    return reply.send({ view: row });
  });

  app.delete("/api/databases/views/:viewId", { preHandler: app.authenticate }, async (request, reply) => {
    const { viewId } = z.object({ viewId: z.string().uuid() }).parse(request.params);
    const ctx = await viewWorkspace(viewId);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, ctx.workspace_id), "record:update");
    await query(app.db, "DELETE FROM database_views WHERE id=$1", [viewId]);
    return reply.code(204).send();
  });

  // ── Analytics: chart query over records ───────────────────────────────────
  app.post("/api/databases/:id/query", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = ChartQuerySchema.parse(request.body ?? {});
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");
    const { properties, records } = await loadDataset(app, id);
    return reply.send(runChartQuery(records, properties, q));
  });

  // CSV export of every record (formula-injection safe).
  app.get("/api/databases/:id/export.csv", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");
    const db = (await query<{ name: string }>(app.db, "SELECT name FROM databases WHERE id=$1", [id]))[0]!;
    const { properties, records } = await loadDataset(app, id);
    const header = ["id", "title", ...properties.map((p) => p.name), "created_at", "updated_at"];
    const lines = [header.map(csvCell).join(",")];
    for (const r of records) {
      lines.push([r.id, r.values.title, ...properties.map((p) => r.computed?.[p.id] ?? r.values[p.id]), r.created_at, r.updated_at].map(csvCell).join(","));
    }
    const safe = db.name.replace(/[^\w.-]+/g, "-").slice(0, 80) || "database";
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${safe}.csv"`)
      .send(lines.join("\r\n") + "\r\n");
  });

  // ── Workflow (stages, transitions, WIP limits) ────────────────────────────
  app.get("/api/databases/:id/workflow", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");
    return reply.send({ workflow: await loadWorkflow(app.db, id) });
  });

  app.put("/api/databases/:id/workflow", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const wf = WorkflowSchema.parse(request.body);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:update");
    // Both properties must belong to THIS database (no cross-database references).
    const own = await query<{ id: string; type: string; config: Record<string, unknown> }>(app.db, "SELECT id, type, config FROM database_properties WHERE database_id=$1 AND id = ANY($2::uuid[])", [id, [wf.status_property_id, wf.due_property_id].filter(Boolean)]);
    const status = own.find((p) => p.id === wf.status_property_id);
    if (!status || status.type !== "select") return reply.code(400).send({ error: "status_property_id must be a select property of this database" });
    if (wf.due_property_id && own.find((p) => p.id === wf.due_property_id)?.type !== "date") return reply.code(400).send({ error: "due_property_id must be a date property of this database" });
    const row = await tx(async (c) => {
      // Keep the select options in sync with the stages so boards & charts agree.
      await c.query("UPDATE database_properties SET config = config || $2::jsonb WHERE id=$1", [wf.status_property_id, JSON.stringify({ options: wf.stages.map((s) => ({ name: s.name, color: s.color })) })]);
      return (
        await c.query(
          `INSERT INTO workflows (database_id, status_property_id, due_property_id, stages, transitions, enforce)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (database_id) DO UPDATE SET status_property_id=EXCLUDED.status_property_id, due_property_id=EXCLUDED.due_property_id,
             stages=EXCLUDED.stages, transitions=EXCLUDED.transitions, enforce=EXCLUDED.enforce, updated_at=now()
           RETURNING id, status_property_id, due_property_id, stages, transitions, enforce`,
          [id, wf.status_property_id, wf.due_property_id, JSON.stringify(wf.stages), JSON.stringify(wf.transitions), wf.enforce],
        )
      ).rows[0];
    });
    return reply.send({ workflow: row });
  });

  app.delete("/api/databases/:id/workflow", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:update");
    await query(app.db, "DELETE FROM workflows WHERE database_id=$1", [id]);
    return reply.code(204).send();
  });

  // ── Progress tracking (burn-up, throughput, lead/cycle time, WIP) ─────────
  app.get("/api/databases/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).parse(request.query);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");
    const wf = await loadWorkflow(app.db, id);
    if (!wf) return reply.code(404).send({ error: "this database has no workflow — PUT /workflow first" });
    const records = await query<{ id: string; values: Record<string, unknown>; created_at: Date }>(app.db, "SELECT id, values, created_at FROM database_records WHERE database_id=$1", [id]);
    const events = await query<{ record_id: string; kind: string; property_id: string | null; to_value: unknown; created_at: Date }>(
      app.db,
      "SELECT record_id, kind, property_id, to_value, created_at FROM record_events WHERE database_id=$1 AND kind IN ('created','stage_changed','deleted') ORDER BY created_at, id LIMIT 200000",
      [id],
    );
    return reply.send(computeProgress({ workflow: wf, records, events, dueProperty: wf.due_property_id, days: q.days }));
  });

  // Activity feed: recent changes with actor emails.
  app.get("/api/databases/:id/activity", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), record_id: z.string().uuid().optional() }).parse(request.query);
    const wsId = await dbWorkspace(id);
    if (!wsId) return reply.code(404).send({ error: "not found" });
    assertCan(await wsRole(request.user!.id, wsId), "record:read");
    const rows = await query(
      app.db,
      `SELECT e.id, e.record_id, e.kind, e.property_id, e.from_value, e.to_value, e.created_at, u.email AS actor
         FROM record_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.database_id=$1 AND ($2::uuid IS NULL OR e.record_id=$2)
        ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
      [id, q.record_id ?? null, q.limit],
    );
    return reply.send({ events: rows });
  });
}
