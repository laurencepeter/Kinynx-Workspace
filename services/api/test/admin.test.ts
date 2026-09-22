import assert from "node:assert/strict";
import { after, test } from "node:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { canonicalJson } from "@kinynx/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

// Generate a signing keypair and configure the app to trust its public key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.KINYNX_LICENSE_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");

let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  dbAvailable = true;
} catch (err) {
  console.warn(`[admin.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

let seq = 0;
async function ownerToken() {
  const email = `admin${s}-${seq++}@ex.com`;
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  // Creating an org makes this user an owner → deployment admin (ADMIN_EMAILS unset).
  await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "AdminOrg" } });
  return token;
}

test("billing plans catalog is public and lists tiers", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/billing/plans" });
  const ids = res.json().plans.map((p: { id: string }) => p.id);
  assert.deepEqual(ids.sort(), ["community", "enterprise", "team"]);
});

test("manual billing checkout returns instructions, not a redirect", { skip }, async () => {
  const token = await ownerToken();
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "BillOrg" } })).json().organization;
  const res = await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/billing/checkout`, headers: auth(token), payload: { plan: "enterprise" } });
  assert.equal(res.json().mode, "manual");
});

test("non-admin is refused admin stats", { skip }, async () => {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `plain${s}@ex.com`, password: "supersecret1" } });
  const res = await app!.inject({ method: "GET", url: "/api/admin/stats", headers: auth(reg.json().access_token) });
  assert.equal(res.statusCode, 403);
});

test("admin stats + health are available to a deployment admin", { skip }, async () => {
  const token = await ownerToken();
  const stats = await app!.inject({ method: "GET", url: "/api/admin/stats", headers: auth(token) });
  assert.equal(stats.statusCode, 200);
  assert.ok(stats.json().counts.users >= 1);
  const health = await app!.inject({ method: "GET", url: "/api/admin/health", headers: auth(token) });
  assert.equal(health.json().checks.database, "ok");
});

test("uploading a valid license activates Enterprise at runtime", { skip }, async () => {
  const token = await ownerToken();
  const payload = {
    license_id: "LIC-TEST",
    organization_id: "00000000-0000-0000-0000-000000000000",
    plan: "enterprise",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1e10).toISOString(),
    user_limit: 250,
  };
  const signature = edSign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");

  const before = await app!.inject({ method: "GET", url: "/api/system/info" });
  assert.equal(before.json().edition, "Community");

  const res = await app!.inject({ method: "POST", url: "/api/admin/license", headers: auth(token), payload: { payload, signature } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().edition, "Enterprise");

  const after = await app!.inject({ method: "GET", url: "/api/system/info" });
  assert.equal(after.json().edition, "Enterprise");
  assert.equal(after.json().features.sso_saml, true);
});

test("a tampered license is rejected", { skip }, async () => {
  const token = await ownerToken();
  const res = await app!.inject({ method: "POST", url: "/api/admin/license", headers: auth(token), payload: { payload: { license_id: "x", plan: "enterprise" }, signature: "bogus" } });
  assert.equal(res.statusCode, 400);
});
