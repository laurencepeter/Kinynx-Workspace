export * from "./types.js";
export * from "./reconcile.js";
export * from "./apply.js";
export { LdapDirectory, type LdapConfig } from "./drivers/ldap.js";
export { AuthentikDirectory, type AuthentikConfig } from "./drivers/authentik.js";

import type pg from "pg";
import { applyDirectorySync, type ApplyOptions } from "./apply.js";
import type { DirectoryProvider, SyncSummary } from "./types.js";

/**
 * Convenience: fetch a provider's snapshot and apply it to an organization.
 * Call this from a scheduled worker (or a SCIM webhook handler) in an
 * enterprise deployment.
 */
export async function runDirectorySync(
  pool: pg.Pool,
  organizationId: string,
  provider: DirectoryProvider,
  options?: ApplyOptions,
): Promise<SyncSummary> {
  const snapshot = await provider.fetchSnapshot();
  return applyDirectorySync(pool, organizationId, snapshot, options);
}
