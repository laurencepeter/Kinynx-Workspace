import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ChartQuerySchema, csvCell, runChartQuery, type PropertyInfo, type RecordInput } from "../src/analytics/query.js";
import { checkTransition, computeProgress } from "../src/analytics/workflow.js";
import { renderHtml } from "../src/analytics/report.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

// ── Pure unit tests (no DB) ──────────────────────────────────────────────────
const STATUS = "00000000-0000-4000-8000-000000000001";
const POINTS = "00000000-0000-4000-8000-000000000002";
const TAGS = "00000000-0000-4000-8000-000000000003";
const props: PropertyInfo[] = [
  { id: STATUS, name: "Status", type: "select", config: { options: [{ name: "Todo", color: "#e66767" }, { name: "Doing", color: "#c98500" }, { name: "Done", color: "#199e70" }] } },
  { id: POINTS, name: "Points", type: "number", config: {} },
  { id: TAGS, name: "Tags", type: "multi_select", config: {} },
];
const rec = (id: string, values: Record<string, unknown>, created: string): RecordInput => ({ id, values, created_at: created, updated_at: created });
const records = [
  rec("a", { [STATUS]: "Done", [POINTS]: 3, [TAGS]: ["api", "ui"] }, "2026-01-05T10:00:00Z"),
  rec("b", { [STATUS]: "Todo", [POINTS]: 5, [TAGS]: ["api"] }, "2026-01-06T10:00:00Z"),
  rec("c", { [STATUS]: "Done", [POINTS]: 2 }, "2026-01-20T10:00:00Z"),
  rec("d", { [POINTS]: 8 }, "2026-02-02T10:00:00Z"),
];

test("chart query groups by select in option order with colours", () => {
  const r = runChartQuery(records, props, ChartQuerySchema.parse({ group_by: STATUS }));
  assert.deepEqual(r.labels, ["Todo", "Done", "(empty)"]);
  assert.deepEqual(r.series[0]!.data, [1, 2, 1]);
  assert.deepEqual(r.series[0]!.colors, ["#e66767", "#199e70", null]);
  assert.equal(r.total, 4);
});

test("chart query sums a metric, filters, and splits multi-select", () => {
  const sum = runChartQuery(records, props, ChartQuerySchema.parse({ group_by: STATUS, metric: { agg: "sum", property: POINTS }, filters: [{ property: POINTS, op: "gte", value: 3 }] }));
  assert.deepEqual(sum.labels, ["Todo", "Done", "(empty)"]);
  assert.deepEqual(sum.series[0]!.data, [5, 3, 8]);
  const tags = runChartQuery(records, props, ChartQuerySchema.parse({ group_by: TAGS, sort: "value_desc" }));
  assert.deepEqual(tags.labels.slice(0, 2), ["api", "(empty)"]);
  assert.equal(tags.series[0]!.data[0], 2);
});

test("chart query buckets dates by week with gap filling and cumulative totals", () => {
  const r = runChartQuery(records, props, ChartQuerySchema.parse({ group_by: "created_at", bucket: "week", cumulative: true }));
  assert.deepEqual(r.labels, ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02"]);
  assert.deepEqual(r.series[0]!.data, [2, 2, 3, 3, 4]);
});

test("chart query rejects unknown filter operators (no code paths for user input)", () => {
  assert.throws(() => ChartQuerySchema.parse({ filters: [{ property: STATUS, op: "$where", value: "1" }] }));
});

test("csvCell neutralises formula injection and quotes", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell("a,b"), `"a,b"`);
});

test("checkTransition enforces allowed moves and WIP limits", () => {
  const wf = {
    stages: [
      { name: "Todo", color: "#e66767", category: "todo" as const, wip_limit: null },
      { name: "Doing", color: "#c98500", category: "active" as const, wip_limit: 2 },
      { name: "Done", color: "#199e70", category: "done" as const, wip_limit: null },
    ],
    transitions: { Todo: ["Doing"], Doing: ["Done", "Todo"] },
  };
  assert.equal(checkTransition(wf, "Todo", "Doing", 0).ok, true);
  assert.deepEqual(checkTransition(wf, "Todo", "Done", 0), { ok: false, code: 422, error: 'moving from "Todo" to "Done" is not allowed' });
  assert.equal((checkTransition(wf, "Todo", "Doing", 2) as { code: number }).code, 409);
  assert.equal((checkTransition(wf, null, "Nope", 0) as { code: number }).code, 422);
  assert.equal(checkTransition(wf, "Done", "Todo", 0).ok, true); // no rule for Done → any
});

test("computeProgress replays events into burn-up, throughput and lead time", () => {
  const now = Date.parse("2026-03-10T12:00:00Z");
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const wf = {
    status_property_id: STATUS,
    stages: [
      { name: "Todo", color: "#e66767", category: "todo" as const, wip_limit: null },
      { name: "Doing", color: "#c98500", category: "active" as const, wip_limit: 1 },
      { name: "Done", color: "#199e70", category: "done" as const, wip_limit: null },
    ],
  };
  const events = [
    { record_id: "a", kind: "created", property_id: null, to_value: { [STATUS]: "Todo" }, created_at: day(10) },
    { record_id: "b", kind: "created", property_id: null, to_value: { [STATUS]: "Todo" }, created_at: day(9) },
    { record_id: "a", kind: "stage_changed", property_id: STATUS, to_value: "Doing", created_at: day(8) },
    { record_id: "a", kind: "stage_changed", property_id: STATUS, to_value: "Done", created_at: day(6) },
    { record_id: "c", kind: "created", property_id: null, to_value: { [STATUS]: "Doing" }, created_at: day(3) },
  ];
  const recs = [
    { id: "a", values: { [STATUS]: "Done" }, created_at: day(10) },
    { id: "b", values: { [STATUS]: "Todo", due: day(1) }, created_at: day(9) },
    { id: "c", values: { [STATUS]: "Doing" }, created_at: day(3) },
  ];
  const p = computeProgress({ workflow: wf, records: recs, events, dueProperty: "due", days: 14, now });
  assert.equal(p.total, 3);
  assert.equal(p.completion_pct, 33.3);
  assert.equal(p.overdue, 1);
  assert.equal(p.lead_time_days, 4);
  assert.equal(p.cycle_time_days, 2);
  assert.equal(p.burnup.at(-1)!.scope, 3);
  assert.equal(p.burnup.at(-1)!.done, 1);
  assert.equal(p.burnup.find((d) => d.date === day(6).slice(0, 10))!.completed, 1);
  assert.deepEqual(p.by_stage.map((s) => s.count), [1, 1, 1]);
  assert.ok(p.forecast_done_date);
});

test("HTML report escapes user content and refuses unsafe colours", () => {
  const html = renderHtml({
    title: "<script>alert(1)</script>",
    description: "",
    generatedAt: new Date(0),
    generatedBy: "x@y.z",
    widgets: [{ title: "T", type: "bar", database: "D", chart: { labels: ["<img src=x onerror=1>"], series: [{ name: "n", color: "red;}</style><script>", data: [1] }], total: 1, metric: { agg: "count", property: null } } }],
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("red;}"));
});

// ── Integration (DB) ─────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";
let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  dbAvailable = true;
} catch (err) {
  console.warn(`[analytics.test] skipping integration: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

async function setup(tag: string) {
  const token = (await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `${tag}${s}@ex.com`, password: "supersecret1" } })).json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: tag } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(token), payload: { name: "W" } })).json().workspace;
  const db = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/databases`, headers: auth(token), payload: { name: "Tasks" } })).json().database;
  const status = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(token), payload: { name: "Status", type: "select", config: { options: [] } } })).json().property;
  const points = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(token), payload: { name: "Points", type: "number" } })).json().property;
  return { token, ws, db, status, points };
}

test("workflow is enforced server-side and feeds progress + dashboards + reports", { skip }, async () => {
  const { token, ws, db, status, points } = await setup("wf");
  const put = await app!.inject({
    method: "PUT", url: `/api/databases/${db.id}/workflow`, headers: auth(token),
    payload: {
      status_property_id: status.id,
      stages: [
        { name: "Todo", color: "#e66767", category: "todo" },
        { name: "Doing", color: "#c98500", category: "active", wip_limit: 1 },
        { name: "Done", color: "#199e70", category: "done" },
      ],
      transitions: { Todo: ["Doing"], Doing: ["Done", "Todo"] },
    },
  });
  assert.equal(put.statusCode, 200, put.body);
  // Select options are synced to the stages.
  const props = (await app!.inject({ method: "GET", url: `/api/databases/${db.id}`, headers: auth(token) })).json().properties;
  assert.deepEqual(props.find((p: { id: string }) => p.id === status.id).config.options.map((o: { name: string }) => o.name), ["Todo", "Doing", "Done"]);

  const mk = async (v: Record<string, unknown>) => app!.inject({ method: "POST", url: `/api/databases/${db.id}/records`, headers: auth(token), payload: { values: v } });
  const a = (await mk({ title: "A", [status.id]: "Todo", [points.id]: 3 })).json().record;
  const b = (await mk({ title: "B", [status.id]: "Todo", [points.id]: 5 })).json().record;
  assert.equal((await mk({ [status.id]: "Bogus" })).statusCode, 422);
  assert.equal((await mk({ "not-a-prop": 1 })).statusCode, 400);

  const move = (id: string, to: string) => app!.inject({ method: "PATCH", url: `/api/records/${id}`, headers: auth(token), payload: { values: { [status.id]: to } } });
  assert.equal((await move(a.id, "Done")).statusCode, 422); // Todo → Done not allowed
  assert.equal((await move(a.id, "Doing")).statusCode, 200);
  assert.equal((await move(b.id, "Doing")).statusCode, 409); // WIP limit 1
  assert.equal((await move(a.id, "Done")).statusCode, 200);

  const prog = (await app!.inject({ method: "GET", url: `/api/databases/${db.id}/progress?days=14`, headers: auth(token) })).json();
  assert.equal(prog.total, 2);
  assert.equal(prog.completion_pct, 50);
  assert.equal(prog.burnup.at(-1).done, 1);

  const activity = (await app!.inject({ method: "GET", url: `/api/databases/${db.id}/activity`, headers: auth(token) })).json().events;
  assert.ok(activity.some((e: { kind: string; actor: string }) => e.kind === "stage_changed" && e.actor === `wf${s}@ex.com`));

  const chart = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/query`, headers: auth(token), payload: { group_by: status.id, metric: { agg: "sum", property: points.id } } })).json();
  assert.deepEqual(chart.labels, ["Todo", "Done"]);
  assert.deepEqual(chart.series[0].data, [5, 3]);

  const dash = await app!.inject({
    method: "POST", url: `/api/workspaces/${ws.id}/dashboards`, headers: auth(token),
    payload: { name: "Sprint", widgets: [
      { id: "w1", title: "By status", type: "bar", database_id: db.id, query: { group_by: status.id } },
      { id: "w2", title: "Progress", type: "progress", database_id: db.id },
      { id: "w3", title: "Points", type: "number", database_id: db.id, query: { metric: { agg: "sum", property: points.id } } },
    ] },
  });
  assert.equal(dash.statusCode, 201, dash.body);
  const dashId = dash.json().dashboard.id;
  const data = (await app!.inject({ method: "GET", url: `/api/dashboards/${dashId}/data`, headers: auth(token) })).json();
  assert.equal(data.widgets.length, 3);
  assert.equal(data.widgets[1].progress.completion_pct, 50);
  assert.equal(data.widgets[2].chart.series[0].data[0], 8);

  for (const fmt of ["md", "csv", "html"]) {
    const rep = await app!.inject({ method: "GET", url: `/api/dashboards/${dashId}/report?format=${fmt}`, headers: auth(token) });
    assert.equal(rep.statusCode, 200);
    assert.match(String(rep.headers["content-disposition"]), /attachment/);
    assert.match(String(rep.headers["content-security-policy"]), /sandbox/);
  }

  const csv = await app!.inject({ method: "GET", url: `/api/databases/${db.id}/export.csv`, headers: auth(token) });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body, /^id,title,Status,Points/);
});

test("dashboards cannot reference another workspace's database", { skip }, async () => {
  const mine = await setup("dashA");
  const theirs = await setup("dashB");
  const res = await app!.inject({
    method: "POST", url: `/api/workspaces/${mine.ws.id}/dashboards`, headers: auth(mine.token),
    payload: { name: "Leak", widgets: [{ id: "x", title: "X", type: "table", database_id: theirs.db.id }] },
  });
  assert.equal(res.statusCode, 400);
  // And outsiders cannot read the dashboard or query the database.
  const d = (await app!.inject({ method: "POST", url: `/api/workspaces/${mine.ws.id}/dashboards`, headers: auth(mine.token), payload: { name: "Mine" } })).json().dashboard;
  assert.equal((await app!.inject({ method: "GET", url: `/api/dashboards/${d.id}/data`, headers: auth(theirs.token) })).statusCode, 403);
  assert.equal((await app!.inject({ method: "POST", url: `/api/databases/${mine.db.id}/query`, headers: auth(theirs.token), payload: {} })).statusCode, 403);
});

test("workspace settings accept only the strict customization schema", { skip }, async () => {
  const { token, ws } = await setup("cust");
  const ok = await app!.inject({ method: "PATCH", url: `/api/workspaces/${ws.id}/settings`, headers: auth(token), payload: { accent: "#9085e9", density: "compact", record_noun: "Ticket", nav: { docs: false } } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().settings.record_noun, "Ticket");
  assert.equal((await app!.inject({ method: "PATCH", url: `/api/workspaces/${ws.id}/settings`, headers: auth(token), payload: { accent: "red;background:url(x)" } })).statusCode, 400);
  assert.equal((await app!.inject({ method: "PATCH", url: `/api/workspaces/${ws.id}/settings`, headers: auth(token), payload: { evil: { nested: true } } })).statusCode, 400);
  const reset = await app!.inject({ method: "PATCH", url: `/api/workspaces/${ws.id}/settings`, headers: auth(token), payload: { density: null } });
  assert.equal(reset.json().settings.density, undefined);
  const got = (await app!.inject({ method: "GET", url: `/api/workspaces/${ws.id}`, headers: auth(token) })).json().workspace;
  assert.equal(got.settings.accent, "#9085e9");
});
