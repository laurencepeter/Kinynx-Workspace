import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { workspaceRole } from "../access.js";
import { ChartQuerySchema, runChartQuery } from "../analytics/query.js";
import { computeProgress, type Workflow } from "../analytics/workflow.js";
import { renderCsv, renderHtml, renderMarkdown, type ReportWidget } from "../analytics/report.js";
import { loadDataset } from "./databases.js";

/**
 * Dashboards: saved layouts of chart / KPI / table / progress widgets over a
 * workspace's databases, plus generated reports (Markdown, CSV, HTML).
 *
 * SECURITY: a widget may only reference databases in the dashboard's own
 * workspace. This is checked on write AND on every read, so a database moved or
 * a crafted payload can never leak another workspace's records.
 */
export const WIDGET_TYPES = ["bar", "column", "stacked", "line", "area", "donut", "number", "table", "progress"] as const;

const WidgetSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  title: z.string().trim().min(1).max(120),
  type: z.enum(WIDGET_TYPES),
  database_id: z.string().uuid(),
  query: ChartQuerySchema.default({}),
  days: z.number().int().min(7).max(365).default(30), // progress widgets
  w: z.number().int().min(1).max(4).default(2), // grid columns (of 4)
});
const WidgetsSchema = z.array(WidgetSchema).max(24);
type Widget = z.infer<typeof WidgetSchema>;

const DashboardBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  widgets: WidgetsSchema.default([]),
});

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  const role = (userId: string, wsId: string) => workspaceRole(app.db, userId, wsId);

  async function dashboard(id: string) {
    return (await query<{ id: string; workspace_id: string; name: string; description: string; widgets: Widget[]; updated_at: Date }>(app.db, "SELECT id, workspace_id, name, description, widgets, updated_at FROM dashboards WHERE id=$1", [id]))[0] ?? null;
  }

  /** Names of the databases that belong to `wsId`, keyed by id. */
  async function ownDatabases(wsId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await query<{ id: string; name: string }>(app.db, "SELECT id, name FROM databases WHERE workspace_id=$1 AND id = ANY($2::uuid[])", [wsId, ids]);
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async function assertWidgetsInWorkspace(wsId: string, widgets: Widget[]): Promise<string | null> {
    const own = await ownDatabases(wsId, [...new Set(widgets.map((w) => w.database_id))]);
    const bad = widgets.find((w) => !own.has(w.database_id));
    return bad ? `widget "${bad.title}" references a database outside this workspace` : null;
  }

  app.get("/api/workspaces/:workspaceId/dashboards", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    assertCan(await role(request.user!.id, workspaceId), "record:read");
    const rows = await query(app.db, "SELECT id, name, description, jsonb_array_length(widgets) AS widget_count, updated_at FROM dashboards WHERE workspace_id=$1 ORDER BY created_at", [workspaceId]);
    return reply.send({ dashboards: rows });
  });

  app.post("/api/workspaces/:workspaceId/dashboards", { preHandler: app.authenticate }, async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = DashboardBody.parse(request.body);
    assertCan(await role(request.user!.id, workspaceId), "record:create");
    const bad = await assertWidgetsInWorkspace(workspaceId, body.widgets);
    if (bad) return reply.code(400).send({ error: bad });
    const row = (await query(app.db, "INSERT INTO dashboards (workspace_id, name, description, widgets, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, description, widgets", [workspaceId, body.name, body.description, JSON.stringify(body.widgets), request.user!.id]))[0];
    return reply.code(201).send({ dashboard: row });
  });

  app.get("/api/dashboards/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const d = await dashboard(id);
    if (!d) return reply.code(404).send({ error: "not found" });
    assertCan(await role(request.user!.id, d.workspace_id), "record:read");
    return reply.send({ dashboard: d });
  });

  app.patch("/api/dashboards/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = DashboardBody.partial().parse(request.body);
    const d = await dashboard(id);
    if (!d) return reply.code(404).send({ error: "not found" });
    assertCan(await role(request.user!.id, d.workspace_id), "record:update");
    if (body.widgets) {
      const bad = await assertWidgetsInWorkspace(d.workspace_id, body.widgets);
      if (bad) return reply.code(400).send({ error: bad });
    }
    const row = (
      await query(
        app.db,
        "UPDATE dashboards SET name=COALESCE($2,name), description=COALESCE($3,description), widgets=COALESCE($4,widgets), updated_at=now() WHERE id=$1 RETURNING id, name, description, widgets",
        [id, body.name ?? null, body.description ?? null, body.widgets ? JSON.stringify(body.widgets) : null],
      )
    )[0];
    return reply.send({ dashboard: row });
  });

  app.delete("/api/dashboards/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const d = await dashboard(id);
    if (!d) return reply.code(404).send({ error: "not found" });
    assertCan(await role(request.user!.id, d.workspace_id), "record:delete");
    await query(app.db, "DELETE FROM dashboards WHERE id=$1", [id]);
    return reply.code(204).send();
  });

  /** Evaluate every widget of a dashboard (re-checking workspace ownership). */
  async function evaluate(d: NonNullable<Awaited<ReturnType<typeof dashboard>>>) {
    const widgets = WidgetsSchema.parse(d.widgets);
    const own = await ownDatabases(d.workspace_id, [...new Set(widgets.map((w) => w.database_id))]);
    const datasets = new Map<string, Awaited<ReturnType<typeof loadDataset>>>();
    const out: Array<ReportWidget & { id: string; w: number; database_id: string }> = [];
    for (const w of widgets) {
      const base = { id: w.id, w: w.w, title: w.title, type: w.type, database_id: w.database_id, database: own.get(w.database_id) ?? "—" };
      if (!own.has(w.database_id)) { out.push({ ...base, error: "database not available" }); continue; }
      if (w.type === "progress") {
        const wf = (await query<Workflow>(app.db, "SELECT status_property_id, due_property_id, stages, transitions, enforce FROM workflows WHERE database_id=$1", [w.database_id]))[0];
        if (!wf) { out.push({ ...base, error: "no workflow configured for this database" }); continue; }
        const records = await query<{ id: string; values: Record<string, unknown>; created_at: Date }>(app.db, "SELECT id, values, created_at FROM database_records WHERE database_id=$1", [w.database_id]);
        const events = await query<{ record_id: string; kind: string; property_id: string | null; to_value: unknown; created_at: Date }>(app.db, "SELECT record_id, kind, property_id, to_value, created_at FROM record_events WHERE database_id=$1 AND kind IN ('created','stage_changed','deleted') ORDER BY created_at, id LIMIT 200000", [w.database_id]);
        out.push({ ...base, progress: computeProgress({ workflow: wf, records, events, dueProperty: wf.due_property_id, days: w.days }) });
        continue;
      }
      let ds = datasets.get(w.database_id);
      if (!ds) { ds = await loadDataset(app, w.database_id); datasets.set(w.database_id, ds); }
      const q = w.type === "number" ? { ...w.query, group_by: undefined, split_by: undefined } : w.query;
      out.push({ ...base, chart: runChartQuery(ds.records, ds.properties, q) });
    }
    return out;
  }

  app.get("/api/dashboards/:id/data", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const d = await dashboard(id);
    if (!d) return reply.code(404).send({ error: "not found" });
    assertCan(await role(request.user!.id, d.workspace_id), "record:read");
    return reply.send({ dashboard: { id: d.id, name: d.name, description: d.description }, widgets: await evaluate(d) });
  });

  // Generated report. Served as a download; the HTML variant gets a CSP that
  // forbids scripts so it is inert even if opened directly.
  app.get("/api/dashboards/:id/report", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { format } = z.object({ format: z.enum(["md", "csv", "html", "json"]).default("md") }).parse(request.query);
    const d = await dashboard(id);
    if (!d) return reply.code(404).send({ error: "not found" });
    assertCan(await role(request.user!.id, d.workspace_id), "record:read");
    const input = { title: d.name, description: d.description, generatedAt: new Date(), generatedBy: request.user!.email, widgets: await evaluate(d) };
    if (format === "json") return reply.send(input);
    const safe = d.name.replace(/[^\w.-]+/g, "-").slice(0, 80) || "report";
    const types = { md: "text/markdown", csv: "text/csv", html: "text/html" } as const;
    const body = format === "md" ? renderMarkdown(input) : format === "csv" ? renderCsv(input) : renderHtml(input);
    return reply
      .header("content-type", `${types[format]}; charset=utf-8`)
      .header("content-disposition", `attachment; filename="${safe}-report.${format}"`)
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
      .header("x-content-type-options", "nosniff")
      .send(body);
  });
}
