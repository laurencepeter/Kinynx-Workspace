/** Environment configuration, validated once at startup. */
import { z } from "zod";

/** Env booleans: "false"/"0"/"no"/"off" → false (z.coerce.boolean treats any non-empty string as true). */
const envBool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return def;
      if (typeof v === "boolean") return v;
      return !["false", "0", "no", "off"].includes(v.trim().toLowerCase());
    });

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().default(4000),
  PUBLIC_APP_URL: z.string().default("http://localhost"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  ACCESS_TOKEN_TTL: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().default(2_592_000),
  KINYNX_LICENSE_FILE: z.string().optional(),
  KINYNX_LICENSE_PUBLIC_KEY: z.string().optional(),
  // Comma-separated emails allowed to use the deployment admin console/license.
  // If unset, any organization owner is treated as a deployment admin (self-host).
  ADMIN_EMAILS: z.string().optional(),

  // ── OIDC / OAuth single sign-on (generic; works with Authentik, Keycloak,
  //    Google, Okta, Entra ID, …). Explicit endpoints avoid live discovery. ──
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_AUTH_URL: z.string().optional(),
  OIDC_TOKEN_URL: z.string().optional(),
  OIDC_USERINFO_URL: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().optional(),
  OIDC_SCOPES: z.string().default("openid email profile"),

  // ── SAML 2.0 SSO (SP-initiated) ──────────────────────────────────────────
  SAML_ENTRY_POINT: z.string().optional(), // IdP SSO URL
  SAML_ISSUER: z.string().optional(), // SP entity id
  SAML_IDP_CERT: z.string().optional(), // IdP signing certificate (PEM/base64)
  SAML_CALLBACK_URL: z.string().optional(), // ACS URL

  // ── Email ──────────────────────────────────────────────────────────────
  EMAIL_DRIVER: z.enum(["console", "smtp", "mailjet"]).default("console"),
  EMAIL_FROM: z.string().default("Kinynx <no-reply@kinynx.local>"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAILJET_API_KEY: z.string().optional(),
  MAILJET_SECRET_KEY: z.string().optional(),

  // ── Object storage ───────────────────────────────────────────────────────
  STORAGE_DRIVER: z.enum(["local", "s3", "minio"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./data/uploads"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("kinynx"),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: envBool(true),

  // ── AI provider (pluggable; self-hosters can use local models) ───────────
  AI_PROVIDER: z.enum(["none", "mock", "anthropic", "openai", "google", "ollama", "openrouter", "custom"]).default("none"),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_MODEL: z.string().optional(),
  // Enterprise policy: when false, external providers are refused (local only).
  AI_ALLOW_EXTERNAL: envBool(true),

  // ── Billing (never hard-code a provider into business logic) ─────────────
  BILLING_PROVIDER: z.enum(["manual", "stripe"]).default("manual"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PRICE_TEAM: z.string().optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().optional(),
  BILLING_SUCCESS_URL: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}
