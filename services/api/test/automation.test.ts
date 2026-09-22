import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

let app: FastifyInstance | undefined;
let hookServer: Server | undefined;
let hookUrl = "";
let received: Promise<{ body: any; signature: string | undefined }>;
let dbAvailable = false;

try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  // A tiny server that captures the first webhook delivery.
  received = new Promise((resolve) => {
    hookServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
        resolve({ body: JSON.parse(raw || "{}"), signature: req.headers["x-kinynx-signature"] as string | undefined });
      });
    });
  });
  await new Promise<void>((r) => hookServer!.listen(0, "127.0.0.1", r));
  hookUrl = `http://127.0.0.1:${(hookServer!.address() as AddressInfo).port}/hook`;
  dbAvailable = true;
} catch (err) {
  console.warn(`[automation.test] skipping: ${(err as Error).message}`);
  received = Promise.resolve({ body: null, signature: undefined });
}
after(async () => {
  if (app) await app.close();
  if (hookServer) await new Promise<void>((r) => hookServer!.close(() => r()));
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

test("automation fires a signed webhook when a record matches the filter", { skip }, async () => {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `auto${s}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "Auto" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(token), payload: { name: "W" } })).json().workspace;
  const db = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/databases`, headers: auth(token), payload: { name: "Tasks" } })).json().database;
  const status = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(token), payload: { name: "Status", type: "select", config: { options: [{ name: "Todo" }, { name: "Done" }] } } })).json().property;
  const rec = (await app!.inject({ method: "POST", url: `/api/databases/${db.id}/records`, headers: auth(token), payload: { values: { [status.id]: "Todo" } } })).json().record;

  // WHEN a record is updated with Status = Done, THEN POST a webhook.
  const auto = await app!.inject({
    method: "POST", url: `/api/workspaces/${ws.id}/automations`, headers: auth(token),
    payload: { name: "Notify on Done", trigger_type: "record.updated", trigger_filter: { [status.id]: "Done" }, actions: [{ type: "webhook", config: { url: hookUrl } }] },
  });
  assert.equal(auto.statusCode, 201);
  const autoId = auto.json().automation.id as string;

  // Trigger it.
  await app!.inject({ method: "PATCH", url: `/api/records/${rec.id}`, headers: auth(token), payload: { values: { [status.id]: "Done" } } });

  const delivery = await Promise.race([
    received,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("webhook not received")), 4000)),
  ]);
  assert.equal(delivery.body.event.type, "record.updated");
  assert.equal(delivery.body.event.data.record_id, rec.id);
  assert.ok(delivery.signature?.startsWith("sha256="));

  // A run was logged as success.
  await new Promise((r) => setTimeout(r, 150));
  const runs = await app!.inject({ method: "GET", url: `/api/automations/${autoId}/runs`, headers: auth(token) });
  assert.ok(runs.json().runs.some((r: { status: string }) => r.status === "success"));
});
