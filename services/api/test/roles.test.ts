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
  console.warn(`[roles.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();
let seq = 0;
async function register() {
  const r = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `role${s}-${seq++}@ex.com`, password: "supersecret1" } });
  return { token: r.json().access_token as string, userId: r.json().user.id as string };
}

test("custom roles are gated behind advanced_permissions (Community → 402)", { skip }, async () => {
  const owner = await register();
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "R" } })).json().organization;
  const res = await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/roles`, headers: auth(owner.token), payload: { name: "Manager", base_role: "editor" } });
  assert.equal(res.statusCode, 402);
});

test("a custom role elevates a member's effective permissions", { skip }, async () => {
  // Enable the entitlement for this deployment (as an Enterprise license would).
  app!.entitlements.features.advanced_permissions = true;

  const owner = await register();
  const member = await register();
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "R2" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "W" } })).json().workspace;
  // Member joins as a bare viewer.
  await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/members`, headers: auth(owner.token), payload: { user_id: member.userId, role: "viewer" } });

  // As a viewer, creating a page is forbidden.
  const before = await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(member.token), payload: { title: "Nope" } });
  assert.equal(before.statusCode, 403);

  // Define a custom "Content Manager" role (base editor) and assign it on the workspace.
  const role = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/roles`, headers: auth(owner.token), payload: { name: "Content Manager", base_role: "editor" } })).json().role;
  const assign = await app!.inject({ method: "POST", url: `/api/roles/${role.id}/assign`, headers: auth(owner.token), payload: { user_id: member.userId, scope_type: "workspace", scope_id: ws.id } });
  assert.equal(assign.statusCode, 201);

  // Now the member can create a page.
  const after = await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(member.token), payload: { title: "Yes" } });
  assert.equal(after.statusCode, 201);

  // Unassigning removes the elevation.
  await app!.inject({ method: "POST", url: `/api/roles/${role.id}/unassign`, headers: auth(owner.token), payload: { user_id: member.userId, scope_type: "workspace", scope_id: ws.id } });
  const revoked = await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(member.token), payload: { title: "NoMore" } });
  assert.equal(revoked.statusCode, 403);
});
