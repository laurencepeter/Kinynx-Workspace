import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { aggregate, evaluateFormula } from "../src/database/compute.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

// ── Pure unit tests (no DB) ──────────────────────────────────────────────────
test("evaluateFormula does safe arithmetic with property refs", () => {
  const vals: Record<string, number> = { Price: 10, Qty: 3, Tax: 2 };
  const resolve = (n: string) => vals[n] ?? 0;
  assert.equal(evaluateFormula("[Price] * [Qty]", resolve), 30);
  assert.equal(evaluateFormula("[Price] * [Qty] + [Tax]", resolve), 32);
  assert.equal(evaluateFormula("([Price] + [Tax]) * 2", resolve), 24);
  assert.equal(evaluateFormula("[Missing] + 5", resolve), 5); // unknown → 0
  assert.equal(evaluateFormula("10 / 0", resolve), 0); // div-by-zero guarded
  assert.equal(evaluateFormula("-[Price]", resolve), -10);
});

test("aggregate supports count/sum/avg/min/max", () => {
  assert.equal(aggregate([1, 2, 3], "sum"), 6);
  assert.equal(aggregate([1, 2, 3], "avg"), 2);
  assert.equal(aggregate([1, 2, 3], "count"), 3);
  assert.equal(aggregate([5, 1, 9], "min"), 1);
  assert.equal(aggregate([5, 1, 9], "max"), 9);
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
  console.warn(`[compute.test] skipping integration: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

test("formula property computes at read time", { skip }, async () => {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `calc${s}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "C" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(token), payload: { name: "W" } })).json().workspace;
  const db = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/databases`, headers: auth(token), payload: { name: "Invoice" } })).json().database;
  const price = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(token), payload: { name: "Price", type: "number" } })).json().property;
  const qty = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(token), payload: { name: "Qty", type: "number" } })).json().property;
  const total = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(token), payload: { name: "Total", type: "formula", config: { expression: "[Price] * [Qty]" } } })).json().property;

  await app!.inject({ method: "POST", url: `/api/databases/${db.id}/records`, headers: auth(token), payload: { values: { [price.id]: 10, [qty.id]: 3 } } });
  const res = await app!.inject({ method: "GET", url: `/api/databases/${db.id}/records?compute=1`, headers: auth(token) });
  assert.equal(res.json().records[0].computed[total.id], 30);
});

test("rollup property aggregates related records", { skip }, async () => {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `roll${s}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "R" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(token), payload: { name: "W" } })).json().workspace;
  const projects = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/databases`, headers: auth(token), payload: { name: "Projects" } })).json().database;
  const tasks = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/databases`, headers: auth(token), payload: { name: "Tasks" } })).json().database;

  const hours = (await app!.inject({ method: "POST", url: `/api/databases/${tasks.id}/properties`, headers: auth(token), payload: { name: "Hours", type: "number" } })).json().property;
  const rel = (await app!.inject({ method: "POST", url: `/api/databases/${projects.id}/properties`, headers: auth(token), payload: { name: "Tasks", type: "relation", config: { database_id: tasks.id } } })).json().property;
  const totalHours = (await app!.inject({ method: "POST", url: `/api/databases/${projects.id}/properties`, headers: auth(token), payload: { name: "Total Hours", type: "rollup", config: { via: rel.id, target: hours.id, agg: "sum" } } })).json().property;

  const project = (await app!.inject({ method: "POST", url: `/api/databases/${projects.id}/records`, headers: auth(token), payload: { values: {} } })).json().record;
  const t1 = (await app!.inject({ method: "POST", url: `/api/databases/${tasks.id}/records`, headers: auth(token), payload: { values: { [hours.id]: 5 } } })).json().record;
  const t2 = (await app!.inject({ method: "POST", url: `/api/databases/${tasks.id}/records`, headers: auth(token), payload: { values: { [hours.id]: 8 } } })).json().record;

  // Link tasks to the project via the relation property.
  const pool = getPool();
  await pool.query("INSERT INTO record_relations (from_record_id, property_id, to_record_id) VALUES ($1,$2,$3),($1,$2,$4)", [project.id, rel.id, t1.id, t2.id]);

  const res = await app!.inject({ method: "GET", url: `/api/databases/${projects.id}/records?compute=1`, headers: auth(token) });
  const rec = res.json().records.find((r: { id: string }) => r.id === project.id);
  assert.equal(rec.computed[totalHours.id], 13);
});
