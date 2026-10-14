/**
 * LDAP / Active Directory provider.
 *
 * Reads users and groups from an LDAP directory and normalizes them into a
 * DirectorySnapshot. Group membership is taken from the group's `member`
 * attribute (DNs), which map to user DNs (the users' external ids).
 *
 * The attribute names are configurable to fit OpenLDAP, Active Directory,
 * FreeIPA, etc. Nothing here is Kinynx-specific — it is a thin, typed reader.
 */
import { Client } from "ldapts";
import type { DirGroup, DirUser, DirectoryProvider, DirectorySnapshot } from "../types.js";

export interface LdapConfig {
  url: string; // ldaps://dc.example.com:636
  bindDN: string; // service account DN
  bindPassword: string;
  userBaseDN: string;
  groupBaseDN: string;
  userFilter?: string; // default "(objectClass=person)"
  groupFilter?: string; // default "(objectClass=groupOfNames)"
  attrs?: {
    userId?: string; // default "dn"
    email?: string; // default "mail"
    displayName?: string; // default "cn"
    groupName?: string; // default "cn"
    groupMember?: string; // default "member"
  };
  tlsRejectUnauthorized?: boolean; // default true
}

export class LdapDirectory implements DirectoryProvider {
  readonly source = "ldap" as const;
  constructor(private readonly config: LdapConfig) {}

  async fetchSnapshot(): Promise<DirectorySnapshot> {
    const a = this.config.attrs ?? {};
    const emailAttr = a.email ?? "mail";
    const nameAttr = a.displayName ?? "cn";
    const groupNameAttr = a.groupName ?? "cn";
    const memberAttr = a.groupMember ?? "member";

    const client = new Client({
      url: this.config.url,
      tlsOptions: { rejectUnauthorized: this.config.tlsRejectUnauthorized ?? true },
    });

    try {
      await client.bind(this.config.bindDN, this.config.bindPassword);

      const { searchEntries: userEntries } = await client.search(this.config.userBaseDN, {
        scope: "sub",
        filter: this.config.userFilter ?? "(objectClass=person)",
        attributes: ["dn", emailAttr, nameAttr],
      });
      const users: DirUser[] = userEntries
        .filter((e) => attr(e, emailAttr))
        .map((e) => ({
          externalId: String(e.dn),
          email: attr(e, emailAttr)!,
          displayName: attr(e, nameAttr) ?? undefined,
        }));

      const { searchEntries: groupEntries } = await client.search(this.config.groupBaseDN, {
        scope: "sub",
        filter: this.config.groupFilter ?? "(objectClass=groupOfNames)",
        attributes: ["dn", groupNameAttr, memberAttr],
      });
      const groups: DirGroup[] = groupEntries.map((e) => ({
        externalId: String(e.dn),
        name: attr(e, groupNameAttr) ?? String(e.dn),
        memberExternalIds: multiAttr(e, memberAttr),
      }));

      return { source: this.source, users, groups };
    } finally {
      await client.unbind().catch(() => {});
    }
  }
}

function attr(entry: Record<string, unknown>, key: string): string | null {
  const v = entry[key];
  if (Array.isArray(v)) return v[0] != null ? String(v[0]) : null;
  return v != null ? String(v) : null;
}
function multiAttr(entry: Record<string, unknown>, key: string): string[] {
  const v = entry[key];
  if (Array.isArray(v)) return v.map(String);
  return v != null ? [String(v)] : [];
}
