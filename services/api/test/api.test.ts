import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

// Probe the database at module load so the `skip` flags below are accurate
// (test options are evaluated eagerly, before any before() hook would run).
let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  dbAvailable = true;
} catch (err) {
  console.warn(`[api.test] Postgres unavailable; skipping integration tests. (${(err as Error).message})`);
}

after(async () => {
  if (app) await app.close();
  await closePool();
});

const skip = dbAvailable ? false : "requires Postgres";
const email = `t${Date.now()}@example.com`;
const state = { token: "", orgId: "", workspaceId: "", pageId: "" };

test("register issues a session", { skip }, async () => {
  const res = await app!.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "supersecret1" },
  });
  assert.equal(res.statusCode, 201);
  state.token = res.json().access_token;
  assert.ok(state.token.length > 20);
});

test("unauthenticated org creation is rejected", { skip }, async () => {
  const res = await app!.inject({ method: "POST", url: "/api/organizations", payload: { name: "X" } });
  assert.equal(res.statusCode, 401);
});

test("create org → workspace → page → block", { skip }, async () => {
  const auth = { authorization: `Bearer ${state.token}` };

  const org = await app!.inject({ method: "POST", url: "/api/organizations", headers: auth, payload: { name: "Acme" } });
  assert.equal(org.statusCode, 201);
  state.orgId = org.json().organization.id;

  const ws = await app!.inject({
    method: "POST",
    url: `/api/organizations/${state.orgId}/workspaces`,
    headers: auth,
    payload: { name: "Engineering" },
  });
  assert.equal(ws.statusCode, 201);
  state.workspaceId = ws.json().workspace.id;

  const page = await app!.inject({
    method: "POST",
    url: `/api/workspaces/${state.workspaceId}/pages`,
    headers: auth,
    payload: { title: "Architecture" },
  });
  assert.equal(page.statusCode, 201);
  state.pageId = page.json().page.id;

  const block = await app!.inject({
    method: "POST",
    url: `/api/pages/${state.pageId}/blocks`,
    headers: auth,
    payload: { type: "heading", content: { text: "Overview", level: 1 } },
  });
  assert.equal(block.statusCode, 201);
  assert.equal(block.json().block.type, "heading");
});

test("full-text search finds the created page", { skip }, async () => {
  const res = await app!.inject({
    method: "GET",
    url: "/api/search?q=Architecture",
    headers: { authorization: `Bearer ${state.token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().results.some((r: { title: string }) => r.title === "Architecture"));
});

test("outsider cannot read another user's workspace (server-side enforcement)", { skip }, async () => {
  const reg = await app!.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: `outsider${Date.now()}@example.com`, password: "supersecret1" },
  });
  const outsiderToken = reg.json().access_token;
  const res = await app!.inject({
    method: "GET",
    url: `/api/workspaces/${state.workspaceId}`,
    headers: { authorization: `Bearer ${outsiderToken}` },
  });
  assert.equal(res.statusCode, 403);
});

test("system info reports Community edition by default", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/system/info" });
  assert.equal(res.json().edition, "Community");
  assert.equal(res.json().features.databases, true);
});
