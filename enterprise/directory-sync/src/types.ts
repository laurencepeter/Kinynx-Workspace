/**
 * ════════════════════════════════════════════════════════════════════════════
 * ENTERPRISE MODULE — NOT Apache-2.0. See enterprise/LICENSE (commercial).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Directory sync domain types. A DirectoryProvider (LDAP / Authentik / OIDC /
 * SCIM) produces a normalized {@link DirectorySnapshot}; the reconciler and
 * applier then make Kinynx groups + memberships match it (provisioning and
 * deprovisioning). Everything is keyed on stable external ids, never names.
 */

export type DirectorySource = "ldap" | "authentik" | "oidc" | "scim";

export interface DirUser {
  externalId: string; // e.g. LDAP DN, Authentik user pk/uuid
  email: string;
  displayName?: string;
}

export interface DirGroup {
  externalId: string; // e.g. group DN or Authentik group pk
  name: string;
  memberExternalIds: string[]; // references DirUser.externalId
}

export interface DirectorySnapshot {
  source: DirectorySource;
  users: DirUser[];
  groups: DirGroup[];
}

export interface DirectoryProvider {
  readonly source: DirectorySource;
  /** Read the full set of users/groups/memberships to reconcile against. */
  fetchSnapshot(): Promise<DirectorySnapshot>;
}

export interface SyncSummary {
  usersCreated: number;
  usersMatched: number;
  groupsUpserted: number;
  membershipsAdded: number;
  membershipsRemoved: number;
}
