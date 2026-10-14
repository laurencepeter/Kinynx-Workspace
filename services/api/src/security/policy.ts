/**
 * Organization security-policy enforcement: IP allowlist + org-wide MFA
 * requirement. Enforced at authentication for every authenticated request, so a
 * user who belongs to a policy-bearing org must satisfy it. MFA-enrollment
 * endpoints are exempt so a user prompted to enroll is never locked out.
 *
 * IP matching supports IPv4 CIDR and exact IPv4; an empty/absent allowlist means
 * "no restriction". Unknown/IPv6 client addresses are allowed only when the
 * allowlist is empty (fail-closed for IPv4 policies).
 */
import type pg from "pg";

export interface OrgSecurity {
  ip_allowlist?: string[];
  require_mfa?: boolean;
}

export type PolicyViolation = { code: number; body: Record<string, unknown> } | null;

/** Paths always allowed so users can enroll MFA / read their own status / sign out. */
const EXEMPT_PREFIXES = ["/api/auth/mfa", "/api/auth/logout", "/api/auth/me", "/api/system", "/health"];

export async function enforceOrgSecurity(
  db: pg.Pool,
  userId: string,
  rawPath: string,
  ip: string,
): Promise<PolicyViolation> {
  const path = rawPath.split("?")[0]!;
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return null;

  const { rows } = await db.query<{ user_mfa: boolean; security: OrgSecurity | null }>(
    `SELECT u.mfa_enabled AS user_mfa, o.security
       FROM users u
       LEFT JOIN organization_members m ON m.user_id = u.id
       LEFT JOIN organizations o ON o.id = m.organization_id AND o.security <> '{}'::jsonb
      WHERE u.id = $1`,
    [userId],
  );
  if (rows.length === 0) return null;
  const userMfa = rows[0]!.user_mfa;

  for (const r of rows) {
    const sec = r.security;
    if (!sec) continue;
    if (sec.require_mfa && !userMfa) {
      return { code: 403, body: { error: "your organization requires MFA — enroll at /api/auth/mfa/setup", mfa_enrollment_required: true } };
    }
    if (sec.ip_allowlist && sec.ip_allowlist.length > 0 && !ipAllowed(ip, sec.ip_allowlist)) {
      return { code: 403, body: { error: "access denied from this IP address" } };
    }
  }
  return null;
}

export function ipAllowed(ip: string, allowlist: string[]): boolean {
  const addr = normalizeV4(ip);
  if (addr === null) return false; // non-IPv4 client under an IPv4 policy → deny
  for (const entry of allowlist) {
    const [net, bitsStr] = entry.split("/");
    const netAddr = normalizeV4(net!.trim());
    if (netAddr === null) continue;
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (netAddr & mask)) return true;
  }
  return false;
}

/** Parse an IPv4 dotted quad (handling IPv4-mapped IPv6 like ::ffff:1.2.3.4) to a uint32, or null. */
function normalizeV4(ip: string): number | null {
  let s = ip.trim();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) s = mapped[1]!;
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}
