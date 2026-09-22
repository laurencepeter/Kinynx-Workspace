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
  console.warn(`[ratelimit.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";

test("login is throttled against brute force (per-route rate limit)", { skip }, async () => {
  const email = `rl${Date.now()}@ex.com`;
  await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "supersecret1" } });

  let sawLimited = false;
  for (let i = 0; i < 26; i++) {
    const res = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "wrong-password" } });
    if (res.statusCode === 429) { sawLimited = true; break; }
  }
  assert.equal(sawLimited, true, "expected a 429 after repeated login attempts");
});
