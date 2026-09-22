import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { applyDirectorySync } from "../src/apply.js";
import type { DirectorySnapshot } from "../src/types.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
let pool: pg.Pool | undefined;
let orgId = "";
let ready = false;
try {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await pool.query("SELECT 1 FROM groups LIMIT 1"); // requires migrated schema
  const slug = `dir-${Date.now()}`;
  orgId = (await pool.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id", ["DirOrg", slug])).rows[0]!.id;
  ready = true;
} catch (err) {
  console.warn(`[apply.test] skipping (needs migrated Postgres): ${(err as Error).message}`);
}
after(async () => {
  if (pool) await pool.end();
});
const skip = ready ? false : "requires migrated Postgres";

const s = Date.now();
const snapshotV1: DirectorySnapshot = {
  source: "authentik",
  users: [
    { externalId: "ak-1", email: `alice${s}@corp.com`, displayName: "Alice" },
    { externalId: "ak-2", email: `bob${s}@corp.com`, displayName: "Bob" },
  ],
  groups: [{ externalId: "grp-eng", name: "Engineering", memberExternalIds: ["ak-1", "ak-2"] }],
};

test("provisions users, group, and memberships", { skip }, async () => {
  const summary = await applyDirectorySync(pool!, orgId, snapshotV1);
  assert.equal(summary.usersCreated, 2);
  assert.equal(summary.groupsUpserted, 1);
  assert.equal(summary.membershipsAdded, 2);

  const grp = (await pool!.query<{ id: string }>("SELECT id FROM groups WHERE organization_id=$1 AND source='authentik' AND external_id='grp-eng'", [orgId])).rows[0]!;
  const members = (await pool!.query("SELECT user_id FROM group_members WHERE group_id=$1", [grp.id])).rows;
  assert.equal(members.length, 2);
});

test("is idempotent on re-apply (no changes)", { skip }, async () => {
  const summary = await applyDirectorySync(pool!, orgId, snapshotV1);
  assert.equal(summary.usersCreated, 0);
  assert.equal(summary.usersMatched, 2);
  assert.equal(summary.membershipsAdded, 0);
  assert.equal(summary.membershipsRemoved, 0);
});

test("deprovisions a member removed from the directory group", { skip }, async () => {
  const snapshotV2: DirectorySnapshot = {
    source: "authentik",
    users: snapshotV1.users,
    groups: [{ externalId: "grp-eng", name: "Engineering", memberExternalIds: ["ak-1"] }], // Bob removed
  };
  const summary = await applyDirectorySync(pool!, orgId, snapshotV2);
  assert.equal(summary.membershipsRemoved, 1);
  const grp = (await pool!.query<{ id: string }>("SELECT id FROM groups WHERE organization_id=$1 AND external_id='grp-eng'", [orgId])).rows[0]!;
  const members = (await pool!.query("SELECT user_id FROM group_members WHERE group_id=$1", [grp.id])).rows;
  assert.equal(members.length, 1);
});
