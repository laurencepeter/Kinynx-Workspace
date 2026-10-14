/**
 * Applies a DirectorySnapshot to the Kinynx database (provisioning &
 * deprovisioning). Idempotent: run it on a schedule (or SCIM webhook) and the
 * DB converges to the directory. Enterprise code may write to core tables;
 * the reverse (core importing enterprise) is never allowed.
 */
import type pg from "pg";
import { diffMembers, normalizeEmail, resolveMembers } from "./reconcile.js";
import type { DirectorySnapshot, SyncSummary } from "./types.js";

export interface ApplyOptions {
  /**
   * Default role granted to newly-provisioned users at the org level.
   * Group grants (set separately by admins) determine workspace access.
   */
  defaultOrgRole?: "admin" | "editor" | "commenter" | "viewer";
}

export async function applyDirectorySync(
  pool: pg.Pool,
  organizationId: string,
  snapshot: DirectorySnapshot,
  options: ApplyOptions = {},
): Promise<SyncSummary> {
  const defaultRole = options.defaultOrgRole ?? "viewer";
  const summary: SyncSummary = {
    usersCreated: 0,
    usersMatched: 0,
    groupsUpserted: 0,
    membershipsAdded: 0,
    membershipsRemoved: 0,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Upsert users by email; build externalId -> userId.
    const externalToUserId = new Map<string, string>();
    for (const u of snapshot.users) {
      const email = normalizeEmail(u.email);
      const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE email_norm = $1", [email]);
      let userId: string;
      if (existing.rows[0]) {
        userId = existing.rows[0].id;
        summary.usersMatched++;
      } else {
        // SSO/directory user: no password hash (they authenticate via the IdP).
        const created = await client.query<{ id: string }>(
          "INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id",
          [u.email, u.displayName ?? email.split("@")[0]],
        );
        userId = created.rows[0]!.id;
        summary.usersCreated++;
      }
      externalToUserId.set(u.externalId, userId);
      // Ensure org membership exists (does not downgrade an existing role).
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [organizationId, userId, defaultRole],
      );
    }

    // 2. Upsert groups by (org, source, external_id) and reconcile members.
    for (const g of snapshot.groups) {
      const upserted = await client.query<{ id: string }>(
        `INSERT INTO groups (organization_id, name, source, external_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (organization_id, source, external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id`,
        [organizationId, g.name, snapshot.source, g.externalId],
      );
      const groupId = upserted.rows[0]!.id;
      summary.groupsUpserted++;

      const desired = resolveMembers(g.memberExternalIds, externalToUserId);
      const current = (
        await client.query<{ user_id: string }>("SELECT user_id FROM group_members WHERE group_id = $1", [groupId])
      ).rows.map((r) => r.user_id);

      const { add, remove } = diffMembers(current, desired);
      for (const uid of add) {
        await client.query("INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [groupId, uid]);
      }
      for (const uid of remove) {
        await client.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, uid]);
      }
      summary.membershipsAdded += add.length;
      summary.membershipsRemoved += remove.length;
    }

    await client.query(
      "INSERT INTO audit_logs (organization_id, action, target_type, metadata) VALUES ($1,'directory.sync','organization',$2)",
      [organizationId, JSON.stringify({ source: snapshot.source, ...summary })],
    );
    await client.query("COMMIT");
    return summary;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
