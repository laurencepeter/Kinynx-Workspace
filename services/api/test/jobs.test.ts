import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { applyRetentionForOrg, cleanupExpired } from "../src/jobs/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;

let db: pg.Pool | undefined;
let dbAvailable = false;
try {
  db = getPool(DATABASE_URL);
  await db.query("SELECT 1");
  await runMigrations();
  dbAvailable = true;
} catch (err) {
  console.warn(`[jobs.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const s = Date.now();

test("cleanupExpired purges expired tokens and used single-use tokens", { skip }, async () => {
  const uid = (await db!.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`job${s}@ex.com`])).rows[0]!.id;
  // An expired refresh token and a used magic link.
  await db!.query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() - interval '1 day')", [uid, `exp-${s}`]);
  await db!.query("INSERT INTO magic_links (email, token_hash, expires_at, used_at) VALUES ($1,$2, now() + interval '1 hour', now())", [`job${s}@ex.com`, `ml-${s}`]);

  const counts = await cleanupExpired(db!);
  assert.ok(counts.refresh_tokens >= 1);
  assert.ok(counts.magic_links >= 1);
  // The expired token is gone.
  const left = await db!.query("SELECT 1 FROM refresh_tokens WHERE token_hash=$1", [`exp-${s}`]);
  assert.equal(left.rows.length, 0);
});

test("applyRetentionForOrg deletes aged rows unless a legal hold is active", { skip }, async () => {
  const org = (await db!.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", ["JobsOrg", `jobs-${s}`])).rows[0]!.id;
  await db!.query("INSERT INTO retention_policies (organization_id, resource, retain_days) VALUES ($1,'audit_logs',0)", [org]);
  await db!.query("INSERT INTO audit_logs (organization_id, action) VALUES ($1,'test.event')", [org]);

  const first = await applyRetentionForOrg(db!, org);
  assert.equal(first.applied, true);
  assert.ok((first.deleted.audit_logs ?? 0) >= 1);

  // Under a legal hold, retention is suspended.
  await db!.query("INSERT INTO audit_logs (organization_id, action) VALUES ($1,'test.event2')", [org]);
  await db!.query("INSERT INTO legal_holds (organization_id) VALUES ($1)", [org]);
  const held = await applyRetentionForOrg(db!, org);
  assert.equal(held.applied, false);
  assert.match(held.reason ?? "", /legal hold/);
});
