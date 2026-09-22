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
  console.warn(`[scim.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

async function ownerOrg() {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `scim${s}-${Math.random()}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "SCIM" } })).json().organization;
  return { token, orgId: org.id as string };
}

test("SCIM is gated behind the entitlement (402 token / 403 endpoint)", { skip }, async () => {
  app!.entitlements.features.scim = false;
  const { token, orgId } = await ownerOrg();
  const tok = await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/scim/token`, headers: auth(token) });
  assert.equal(tok.statusCode, 402);
  const ep = await app!.inject({ method: "POST", url: "/scim/v2/Users", headers: auth("anything"), payload: { userName: "x@y.com" } });
  assert.equal(ep.statusCode, 403);
});

test("SCIM provisions a user, deprovisions, and manages group membership", { skip }, async () => {
  app!.entitlements.features.scim = true;
  const { token, orgId } = await ownerOrg();
  const scimToken = (await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/scim/token`, headers: auth(token) })).json().token as string;
  const S = { authorization: `Bearer ${scimToken}` };

  // Bad token → 401.
  const bad = await app!.inject({ method: "GET", url: '/scim/v2/Users?filter=userName eq "nobody@x.com"', headers: { authorization: "Bearer wrong" } });
  assert.equal(bad.statusCode, 401);

  // Provision a user.
  const email = `scim-user${s}@corp.com`;
  const create = await app!.inject({ method: "POST", url: "/scim/v2/Users", headers: S, payload: { userName: email, emails: [{ value: email, primary: true }], name: { givenName: "Ann", familyName: "Lee" }, active: true } });
  assert.equal(create.statusCode, 201);
  const userId = create.json().id as string;
  assert.equal(create.json().active, true);

  // Filter lookup finds them.
  const list = await app!.inject({ method: "GET", url: `/scim/v2/Users?filter=userName eq "${email}"`, headers: S });
  assert.equal(list.json().totalResults, 1);

  // Deprovision (active:false).
  const deact = await app!.inject({ method: "PATCH", url: `/scim/v2/Users/${userId}`, headers: S, payload: { Operations: [{ op: "replace", path: "active", value: false }] } });
  assert.equal(deact.json().active, false);

  // Group create + add member.
  const group = await app!.inject({ method: "POST", url: "/scim/v2/Groups", headers: S, payload: { displayName: `Engineers ${s}`, externalId: "grp-1" } });
  assert.equal(group.statusCode, 201);
  const addMember = await app!.inject({ method: "PATCH", url: `/scim/v2/Groups/${group.json().id}`, headers: S, payload: { Operations: [{ op: "add", path: "members", value: [{ value: userId }] }] } });
  assert.equal(addMember.statusCode, 204);
});
