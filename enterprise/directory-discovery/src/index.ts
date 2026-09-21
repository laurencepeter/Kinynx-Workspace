/**
 * ════════════════════════════════════════════════════════════════════════════
 * ENTERPRISE MODULE — NOT Apache-2.0. See enterprise/LICENSE (commercial).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * SSO / directory auto-discovery.
 *
 * Goal (from the product request): when a user signs in with a work email, and
 * their organization is in a "workspace environment", Kinynx should AUTO-DETECT
 * the likely identity provider and RECOMMEND SSO settings — which an IT admin
 * then confirms or overrides. It NEVER silently trusts a domain: discovery only
 * *proposes* configuration; provisioning still requires admin approval.
 *
 * How auto-detection works, in layers (most authoritative first):
 *   1. Org-verified domain → an admin-configured connection already exists → use it.
 *   2. Managed-device / Kerberos / IWA hint (header injected by reverse proxy on
 *      a domain-joined machine) → propose desktop SSO (auto sign-in).
 *   3. Well-known provider heuristics from the email domain's MX / discovery URL
 *      (Microsoft Entra, Google Workspace, Okta, etc.) → propose OIDC/SAML.
 *
 * This file is pure/deterministic (no network) so it stays unit-testable; the
 * runtime supplies probe results via {@link DiscoveryProbe}.
 */

export type IdpKind = "oidc" | "saml" | "ldap" | "desktop-sso";

export interface RecommendedConnection {
  provider: string; // human label, e.g. "Microsoft Entra ID"
  kind: IdpKind;
  /** Best-guess endpoints for the admin to confirm. */
  suggested: Record<string, string>;
  /** Whether opening the app can attempt automatic sign-in once configured. */
  autoSignInCapable: boolean;
  confidence: "configured" | "high" | "medium" | "low";
  /** Human guidance shown to the IT admin. */
  note: string;
}

export interface DiscoveryProbe {
  /** Domain from the user's email (e.g. "acme.com"). */
  domain: string;
  /** An existing admin-configured connection for this domain, if any. */
  configuredConnection?: RecommendedConnection;
  /** MX host suffixes observed for the domain (lowercased). */
  mxHosts?: string[];
  /** True if the request arrived from a domain-joined/managed device. */
  managedDeviceHint?: boolean;
  /** A discovered OIDC issuer URL, if a well-known probe succeeded. */
  oidcIssuer?: string;
}

const KNOWN_PROVIDERS: Array<{
  match: (p: DiscoveryProbe) => boolean;
  build: (p: DiscoveryProbe) => RecommendedConnection;
}> = [
  {
    match: (p) => (p.mxHosts ?? []).some((h) => h.endsWith("outlook.com") || h.includes("protection.outlook")),
    build: (p) => ({
      provider: "Microsoft Entra ID",
      kind: "oidc",
      suggested: {
        issuer: "https://login.microsoftonline.com/common/v2.0",
        discovery: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
        scim: "https://graph.microsoft.com/",
      },
      autoSignInCapable: true,
      confidence: p.managedDeviceHint ? "high" : "medium",
      note: "Microsoft 365 detected via MX. Confirm your tenant ID and register an app in Entra ID.",
    }),
  },
  {
    match: (p) => (p.mxHosts ?? []).some((h) => h.endsWith("google.com") || h.endsWith("googlemail.com")),
    build: () => ({
      provider: "Google Workspace",
      kind: "oidc",
      suggested: {
        issuer: "https://accounts.google.com",
        discovery: "https://accounts.google.com/.well-known/openid-configuration",
      },
      autoSignInCapable: true,
      confidence: "medium",
      note: "Google Workspace detected via MX. Confirm the hosted domain (hd) restriction.",
    }),
  },
];

/**
 * Produce an ordered list of recommended SSO connections for a sign-in domain.
 * Highest-confidence first. Returns [] when nothing can be inferred (the user
 * then falls back to email/password, and IT can configure SSO manually).
 */
export function discoverConnections(probe: DiscoveryProbe): RecommendedConnection[] {
  const out: RecommendedConnection[] = [];

  // 1. Already configured wins.
  if (probe.configuredConnection) {
    out.push({ ...probe.configuredConnection, confidence: "configured" });
  }

  // 2. Managed/domain-joined device → desktop SSO (the "auto sign-in on open").
  if (probe.managedDeviceHint) {
    out.push({
      provider: "Desktop SSO (Integrated Windows Auth / Kerberos)",
      kind: "desktop-sso",
      suggested: { header: "X-Forwarded-User", mechanism: "kerberos-spnego" },
      autoSignInCapable: true,
      confidence: "high",
      note:
        "Request came from a domain-joined device. With the reverse proxy configured for " +
        "SPNEGO/Kerberos, opening Kinynx can sign the user in automatically. IT must enable this.",
    });
  }

  // 3. Provider heuristics.
  for (const provider of KNOWN_PROVIDERS) {
    if (provider.match(probe)) out.push(provider.build(probe));
  }

  // 4. A discovered OIDC issuer we don't specifically recognize.
  if (probe.oidcIssuer && !out.some((c) => c.suggested.issuer === probe.oidcIssuer)) {
    out.push({
      provider: "Generic OIDC",
      kind: "oidc",
      suggested: { issuer: probe.oidcIssuer, discovery: `${probe.oidcIssuer}/.well-known/openid-configuration` },
      autoSignInCapable: true,
      confidence: "low",
      note: "An OIDC issuer was discovered for this domain. Confirm client registration with IT.",
    });
  }

  return dedupeByProvider(out);
}

function dedupeByProvider(list: RecommendedConnection[]): RecommendedConnection[] {
  const seen = new Set<string>();
  const result: RecommendedConnection[] = [];
  for (const c of list) {
    if (seen.has(c.provider)) continue;
    seen.add(c.provider);
    result.push(c);
  }
  return result;
}
