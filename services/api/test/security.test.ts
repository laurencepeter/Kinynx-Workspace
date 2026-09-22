import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ipAllowed } from "../src/security/policy.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

// ── Pure CIDR unit tests ─────────────────────────────────────────────────────
test("ipAllowed matches IPv4 CIDR, exact, and mapped addresses", () => {
  assert.equal(ipAllowed("127.0.0.1", ["127.0.0.1/32"]), true);
  assert.equal(ipAllowed("127.0.0.1", ["10.0.0.0/8"]), false);
  assert.equal(ipAllowed("10.1.2.3", ["10.0.0.0/8"]), true);
  assert.equal(ipAllowed("192.168.1.5", ["192.168.1.0/24"]), true);
  assert.equal(ipAllowed("192.168.2.5", ["192.168.1.0/24"]), false);
  assert.equal(ipAllowed("203.0.113.7", ["203.0.113.7"]), true);
  assert.equal(ipAllowed("::ffff:127.0.0.1", ["127.0.0.1/32"]), true);
  assert.equal(ipAllowed("10.0.0.1", []), false);
});

// ── Integration ──────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";
let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  app.entitlements.features.advanced_security = true;
  dbAvailable = true;
} catch (err) {
  console.warn(`[security.test] skipping integration: ${(err as Error).message}`);
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
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `sec${s}-${seq++}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "Sec" } })).json().organization;
  return { token, orgId: org.id as string };
}

test("IP allowlist that excludes the caller blocks subsequent requests", { skip }, async () => {
  const { token, orgId } = await ownerOrg();
  const set = await app!.inject({ method: "PUT", url: `/api/organizations/${orgId}/security`, headers: auth(token), payload: { ip_allowlist: ["10.0.0.0/8"] } });
  assert.equal(set.statusCode, 200);
  // inject requests come from 127.0.0.1, which is not in 10.0.0.0/8.
  const blocked = await app!.inject({ method: "GET", url: "/api/organizations", headers: auth(token) });
  assert.equal(blocked.statusCode, 403);
});

test("IP allowlist that includes the caller permits requests", { skip }, async () => {
  const { token, orgId } = await ownerOrg();
  await app!.inject({ method: "PUT", url: `/api/organizations/${orgId}/security`, headers: auth(token), payload: { ip_allowlist: ["127.0.0.1/32"] } });
  const okReq = await app!.inject({ method: "GET", url: "/api/organizations", headers: auth(token) });
  assert.equal(okReq.statusCode, 200);
});

test("org-wide MFA requirement blocks non-enrolled users but allows enrollment", { skip }, async () => {
  const { token, orgId } = await ownerOrg();
  await app!.inject({ method: "PUT", url: `/api/organizations/${orgId}/security`, headers: auth(token), payload: { require_mfa: true } });
  // A normal request is blocked with an enrollment hint.
  const blocked = await app!.inject({ method: "GET", url: "/api/organizations", headers: auth(token) });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().mfa_enrollment_required, true);
  // But MFA setup itself stays reachable so the user can comply.
  const setup = await app!.inject({ method: "POST", url: "/api/auth/mfa/setup", headers: auth(token) });
  assert.equal(setup.statusCode, 200);
});

test("policy settings are gated behind advanced_security", { skip }, async () => {
  app!.entitlements.features.advanced_security = false;
  const { token, orgId } = await ownerOrg();
  const res = await app!.inject({ method: "PUT", url: `/api/organizations/${orgId}/security`, headers: auth(token), payload: { require_mfa: true } });
  assert.equal(res.statusCode, 402);
  app!.entitlements.features.advanced_security = true;
});
