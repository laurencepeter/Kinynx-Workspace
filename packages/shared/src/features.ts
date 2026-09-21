/**
 * Central feature-flag & entitlement definitions.
 *
 * This is the single source of truth for what each tier unlocks. NOTHING in
 * the codebase should hard-code a tier check inline — always resolve through
 * {@link resolveEntitlements} so limits stay configurable and the Community
 * Edition can never be crippled by a stray `if (plan === 'enterprise')`.
 */

export type Plan = "community" | "team" | "enterprise";

/** Sentinel meaning "no limit". */
export const UNLIMITED = -1 as const;

/**
 * Boolean capability flags. Community Edition MUST keep every capability that
 * makes the product genuinely useful. Only organizational-scale, security,
 * compliance and administration capabilities are gated.
 */
export interface FeatureFlags {
  // ── Core (always on, even in Community) ──────────────────────────────────
  documents: boolean;
  databases: boolean;
  kanban: boolean;
  tables: boolean;
  tasks: boolean;
  comments: boolean;
  collaboration: boolean;
  file_attachments: boolean;
  templates: boolean;
  template_marketplace: boolean;
  publishing: boolean;
  search: boolean;
  api: boolean;
  integrations_basic: boolean;

  // ── Gated (Team / Enterprise) ────────────────────────────────────────────
  advanced_permissions: boolean; // custom roles, fine-grained page ACLs
  audit_logs: boolean;
  sso_saml: boolean;
  sso_oidc: boolean;
  ldap: boolean;
  scim: boolean;
  directory_autodiscovery: boolean; // domain -> recommended SSO settings
  retention_policies: boolean;
  legal_hold: boolean;
  ip_allowlist: boolean;
  mfa_policies: boolean;
  advanced_security: boolean;
  custom_domains: boolean;
  organization_admin: boolean;
  advanced_automation: boolean;
  priority_support: boolean;
}

/** Numeric limits. Use {@link UNLIMITED} for no cap. */
export interface Limits {
  max_users: number;
  max_workspaces: number;
  max_storage_bytes: number;
  max_file_size_bytes: number;
}

export interface Entitlements {
  plan: Plan;
  edition: "Community" | "Enterprise";
  features: FeatureFlags;
  limits: Limits;
}

const GiB = 1024 * 1024 * 1024;

const CORE_FEATURES = {
  documents: true,
  databases: true,
  kanban: true,
  tables: true,
  tasks: true,
  comments: true,
  collaboration: true,
  file_attachments: true,
  templates: true,
  template_marketplace: true,
  publishing: true,
  search: true,
  api: true,
  integrations_basic: true,
} as const;

const NO_ENTERPRISE = {
  advanced_permissions: false,
  audit_logs: false,
  sso_saml: false,
  sso_oidc: false,
  ldap: false,
  scim: false,
  directory_autodiscovery: false,
  retention_policies: false,
  legal_hold: false,
  ip_allowlist: false,
  mfa_policies: false,
  advanced_security: false,
  custom_domains: false,
  organization_admin: false,
  advanced_automation: false,
  priority_support: false,
} as const;

/**
 * Default entitlements per plan. These are DEFAULTS — a valid license may
 * override any limit or flag (e.g. a negotiated Enterprise user cap), which is
 * why nothing downstream should assume these constants.
 */
export const PLAN_DEFAULTS: Record<Plan, Entitlements> = {
  community: {
    plan: "community",
    edition: "Community",
    features: { ...CORE_FEATURES, ...NO_ENTERPRISE },
    limits: {
      max_users: UNLIMITED, // self-hosted community is not user-capped
      max_workspaces: UNLIMITED,
      max_storage_bytes: UNLIMITED,
      max_file_size_bytes: 100 * 1024 * 1024,
    },
  },
  team: {
    plan: "team",
    edition: "Community",
    features: {
      ...CORE_FEATURES,
      ...NO_ENTERPRISE,
      advanced_permissions: true,
      organization_admin: true,
    },
    limits: {
      max_users: 10,
      max_workspaces: UNLIMITED,
      max_storage_bytes: 50 * GiB,
      max_file_size_bytes: 250 * 1024 * 1024,
    },
  },
  enterprise: {
    plan: "enterprise",
    edition: "Enterprise",
    features: {
      ...CORE_FEATURES,
      advanced_permissions: true,
      audit_logs: true,
      sso_saml: true,
      sso_oidc: true,
      ldap: true,
      scim: true,
      directory_autodiscovery: true,
      retention_policies: true,
      legal_hold: true,
      ip_allowlist: true,
      mfa_policies: true,
      advanced_security: true,
      custom_domains: true,
      organization_admin: true,
      advanced_automation: true,
      priority_support: true,
    },
    limits: {
      max_users: UNLIMITED,
      max_workspaces: UNLIMITED,
      max_storage_bytes: UNLIMITED,
      max_file_size_bytes: 5 * GiB,
    },
  },
};

/** True if a value counts as "within limit" for a given usage. */
export function withinLimit(limit: number, usage: number): boolean {
  return limit === UNLIMITED || usage < limit;
}
