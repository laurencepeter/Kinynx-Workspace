/**
 * Pure reconciliation helpers (no I/O) — the testable core of directory sync.
 * Given the current membership and the desired membership, compute the minimal
 * add/remove sets. This is what makes provisioning/deprovisioning deterministic.
 */

export interface MemberDiff {
  add: string[];
  remove: string[];
}

/** Compute members to add/remove to turn `current` into `desired`. */
export function diffMembers(current: Iterable<string>, desired: Iterable<string>): MemberDiff {
  const cur = new Set(current);
  const des = new Set(desired);
  const add: string[] = [];
  const remove: string[] = [];
  for (const id of des) if (!cur.has(id)) add.push(id);
  for (const id of cur) if (!des.has(id)) remove.push(id);
  return { add, remove };
}

/**
 * Resolve a group's desired member USER ids from its directory member external
 * ids, using the external-id → user-id map. External ids with no known user
 * (not yet provisioned) are skipped by the caller after user upsert, so this is
 * a strict lookup.
 */
export function resolveMembers(
  memberExternalIds: string[],
  externalToUserId: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const ext of memberExternalIds) {
    const uid = externalToUserId.get(ext);
    if (uid) out.push(uid);
  }
  return out;
}

/** Normalize an email the same way the core schema does (lowercased). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
