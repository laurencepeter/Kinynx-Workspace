/**
 * Authentik provider.
 *
 * Reads users and groups from an Authentik instance via its REST API
 * (/api/v3/core/users, /api/v3/core/groups) using a service-account API token.
 * Authentik groups embed their members, so one groups call yields memberships.
 * Paginated; follows `pagination.next`.
 *
 * Works the same for any OIDC IdP that exposes a SCIM-like directory API — swap
 * this driver, keep the reconciler/applier.
 */
import type { DirGroup, DirUser, DirectoryProvider, DirectorySnapshot } from "../types.js";

export interface AuthentikConfig {
  baseUrl: string; // https://authentik.example.com
  token: string; // Authentik API token (Bearer)
}

interface AkUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
}
interface AkGroup {
  pk: string;
  name: string;
  users_obj?: Array<{ pk: number }>;
  users?: number[];
}
interface AkPage<T> {
  results: T[];
  pagination?: { next?: number | null };
}

export class AuthentikDirectory implements DirectoryProvider {
  readonly source = "authentik" as const;
  constructor(private readonly config: AuthentikConfig) {}

  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const url = `${this.config.baseUrl.replace(/\/$/, "")}${path}?page_size=200&page=${page}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${this.config.token}`, accept: "application/json" } });
      if (!res.ok) throw new Error(`authentik ${path} failed: ${res.status}`);
      const body = (await res.json()) as AkPage<T>;
      out.push(...body.results);
      if (!body.pagination?.next) break;
      page += 1;
    }
    return out;
  }

  async fetchSnapshot(): Promise<DirectorySnapshot> {
    const akUsers = await this.getAll<AkUser>("/api/v3/core/users/");
    const akGroups = await this.getAll<AkGroup>("/api/v3/core/groups/");

    const users: DirUser[] = akUsers
      .filter((u) => u.is_active && u.email)
      .map((u) => ({ externalId: String(u.pk), email: u.email, displayName: u.name || u.username }));

    const groups: DirGroup[] = akGroups.map((g) => ({
      externalId: g.pk,
      name: g.name,
      memberExternalIds: (g.users_obj?.map((m) => String(m.pk)) ?? g.users?.map(String) ?? []),
    }));

    return { source: this.source, users, groups };
  }
}
