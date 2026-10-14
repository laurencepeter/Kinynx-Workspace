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

let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  dbAvailable = true;
} catch (err) {
  console.warn(`[compliance.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();
let seq = 0;
async function ownerOrg() {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `comp${s}-${seq++}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "Compliance" } })).json().organization;
  return { token, orgId: org.id as string };
}

test("retention/legal-hold are gated behind Enterprise (402 in Community)", { skip }, async () => {
  const { token, orgId } = await ownerOrg();
  const res = await app!.inject({ method: "PUT", url: `/api/organizations/${orgId}/retention`, headers: auth(token), payload: { resource: "audit_logs", retain_days: 30 } });
  assert.equal(res.statusCode, 402);
});

test("retention deletes aged audit logs, and a legal hold suspends it", { skip }, async () => {
  app!.entitlements.features.retention_policies = true;
  app!.entitlements.features.legal_hold = true;

  const { token, orgId } = await ownerOrg(); // org.create writes an audit row
  // Policy: keep 0 days → everything older than now is eligible.
  const set = await app!.inject({ method: "PUT", url: `/api/organizations/${orgId}/retention`, headers: auth(token), payload: { resource: "audit_logs", retain_days: 0 } });
  assert.equal(set.statusCode, 200);

  const before = await app!.inject({ method: "GET", url: `/api/organizations/${orgId}/audit`, headers: auth(token) });
  assert.ok(before.json().events.length >= 1);

  const apply1 = await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/retention/apply`, headers: auth(token) });
  assert.equal(apply1.json().applied, true);
  assert.ok(apply1.json().deleted.audit_logs >= 1);

  // Put the org under legal hold, generate a new audit row, and apply again.
  await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/legal-holds`, headers: auth(token), payload: { reason: "investigation" } });
  const member = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `held${s}-${seq++}@ex.com`, password: "supersecret1" } });
  await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/invitations`, headers: auth(token), payload: { role: "viewer" } }); // no audit, but ensures activity
  void member;

  const apply2 = await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/retention/apply`, headers: auth(token) });
  assert.equal(apply2.json().applied, false);
  assert.match(apply2.json().reason, /legal hold/);

  // Release the hold → retention runs again.
  const holds = (await app!.inject({ method: "GET", url: `/api/organizations/${orgId}/legal-holds`, headers: auth(token) })).json().legal_holds;
  await app!.inject({ method: "POST", url: `/api/legal-holds/${holds[0].id}/release`, headers: auth(token) });
  const apply3 = await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/retention/apply`, headers: auth(token) });
  assert.equal(apply3.json().applied, true);
});
