import assert from "node:assert/strict";
import { after, test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
const REDIS_URL = process.env.REDIS_URL ?? "";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

// Two app instances = two API replicas sharing one Redis + one DB.
let nodeA: FastifyInstance | undefined;
let nodeB: FastifyInstance | undefined;
let portA = 0;
let ready = false;
try {
  if (!REDIS_URL) throw new Error("REDIS_URL not set");
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  const cfg = loadConfig();
  nodeA = await buildApp(cfg);
  nodeB = await buildApp(cfg);
  await nodeA.listen({ host: "127.0.0.1", port: 0 });
  portA = (nodeA.server.address() as AddressInfo).port;
  // Give Redis SUBSCRIBE a moment to be established on both nodes.
  await new Promise((r) => setTimeout(r, 250));
  ready = true;
} catch (err) {
  console.warn(`[realtime-redis.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (nodeA) await nodeA.close();
  if (nodeB) await nodeB.close();
  await closePool();
});
const skip = ready ? false : "requires Postgres + Redis";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test("event on node B reaches a WebSocket client on node A (Redis fan-out)", { skip }, async () => {
  const stamp = Date.now();
  const reg = await nodeA!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `redis${stamp}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await nodeA!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "Cluster" } })).json().organization;
  const ws = (await nodeA!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(token), payload: { name: "Shared" } })).json().workspace;
  const page = (await nodeA!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(token), payload: { title: "P" } })).json().page;

  // Client connects to NODE A.
  const client = new WebSocket(`ws://127.0.0.1:${portA}/api/realtime?workspaceId=${ws.id}&token=${token}`);
  await once(client, "open");
  await new Promise((r) => setTimeout(r, 150)); // let presence settle

  const gotBlock = new Promise<{ by: string }>((resolve) => {
    client.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "block.created") resolve(msg);
    });
  });

  // Mutation happens on NODE B — must reach the node A client via Redis.
  const res = await nodeB!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(token), payload: { type: "paragraph", content: { text: "cross-node" } } });
  assert.equal(res.statusCode, 201);

  const event = await Promise.race([
    gotBlock,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout: no cross-node event")), 3000)),
  ]);
  assert.equal(event.by, `redis${stamp}@ex.com`);
  client.close();
});
