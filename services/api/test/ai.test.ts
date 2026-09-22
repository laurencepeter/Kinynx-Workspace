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
process.env.AI_PROVIDER = "mock";

let app: FastifyInstance | undefined; // mock provider
let policyApp: FastifyInstance | undefined; // external provider, disabled by policy
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  policyApp = await buildApp(loadConfig({ ...process.env, AI_PROVIDER: "openai", AI_ALLOW_EXTERNAL: "false" }));
  dbAvailable = true;
} catch (err) {
  console.warn(`[ai.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  if (policyApp) await policyApp.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

test("AI status reports the configured provider", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/ai/status" });
  assert.equal(res.json().enabled, true);
  assert.equal(res.json().provider, "mock");
});

test("summarize returns a completion for a readable page", { skip }, async () => {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `ai${s}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "AI" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(token), payload: { name: "W" } })).json().workspace;
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(token), payload: { title: "Notes" } })).json().page;
  await app!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(token), payload: { type: "paragraph", content: { text: "The quarterly roadmap covers three initiatives." } } });

  const res = await app!.inject({ method: "POST", url: "/api/ai/summarize", headers: auth(token), payload: { page_id: page.id } });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().summary, /mock summary/);
});

test("external providers are refused when policy disables them", { skip }, async () => {
  const reg = await policyApp!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `aipol${s}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const status = await policyApp!.inject({ method: "GET", url: "/api/ai/status" });
  assert.equal(status.json().external, true);
  assert.equal(status.json().external_allowed, false);
  const res = await policyApp!.inject({ method: "POST", url: "/api/ai/rewrite", headers: auth(token), payload: { text: "hi", instruction: "make formal" } });
  assert.equal(res.statusCode, 403);
});
