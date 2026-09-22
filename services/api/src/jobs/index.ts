/**
 * Background jobs, shared by the API (on-demand retention) and the worker
 * (scheduled). Pure functions over a pg pool so they are unit-testable.
 */
import type pg from "pg";

/** Resources a retention policy may prune (fixed allowlist — never user text). */
export const RETENTION_RESOURCES = ["audit_logs", "notifications"] as const;
export type RetentionResource = (typeof RETENTION_RESOURCES)[number];

export async function orgHasActiveLegalHold(db: pg.Pool, orgId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM legal_holds WHERE organization_id=$1 AND active LIMIT 1", [orgId]);
  return rows.length > 0;
}

/** Apply every retention policy for one org, unless a legal hold suspends it. */
export async function applyRetentionForOrg(
  db: pg.Pool,
  orgId: string,
): Promise<{ applied: boolean; reason?: string; deleted: Record<string, number> }> {
  if (await orgHasActiveLegalHold(db, orgId)) return { applied: false, reason: "legal hold active", deleted: {} };

  const { rows: policies } = await db.query<{ resource: string; retain_days: number }>(
    "SELECT resource, retain_days FROM retention_policies WHERE organization_id=$1",
    [orgId],
  );
  const deleted: Record<string, number> = {};
  for (const p of policies) {
    if (!(RETENTION_RESOURCES as readonly string[]).includes(p.resource)) continue;
    const res = await db.query(
      `DELETE FROM ${p.resource} WHERE organization_id=$1 AND created_at < now() - ($2 || ' days')::interval`,
      [orgId, String(p.retain_days)],
    );
    deleted[p.resource] = res.rowCount ?? 0;
  }
  return { applied: true, deleted };
}

/** Apply retention across every org that has a policy configured. */
export async function applyRetentionAll(db: pg.Pool): Promise<{ orgs: number; deleted: Record<string, number> }> {
  const { rows } = await db.query<{ organization_id: string }>(
    "SELECT DISTINCT organization_id FROM retention_policies",
  );
  const total: Record<string, number> = {};
  for (const r of rows) {
    const out = await applyRetentionForOrg(db, r.organization_id);
    for (const [k, v] of Object.entries(out.deleted)) total[k] = (total[k] ?? 0) + v;
  }
  return { orgs: rows.length, deleted: total };
}

/** Purge expired/spent single-use tokens and invitations. Returns row counts. */
export async function cleanupExpired(db: pg.Pool): Promise<Record<string, number>> {
  const stmts: Array<[string, string]> = [
    ["refresh_tokens", "DELETE FROM refresh_tokens WHERE expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')"],
    ["magic_links", "DELETE FROM magic_links WHERE expires_at < now() OR used_at IS NOT NULL"],
    ["password_resets", "DELETE FROM password_resets WHERE expires_at < now() OR used_at IS NOT NULL"],
    ["invitations", "DELETE FROM invitations WHERE expires_at < now() OR revoked_at IS NOT NULL"],
  ];
  const counts: Record<string, number> = {};
  for (const [name, sql] of stmts) {
    const res = await db.query(sql);
    counts[name] = res.rowCount ?? 0;
  }
  return counts;
}
