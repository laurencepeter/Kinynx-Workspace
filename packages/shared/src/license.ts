/**
 * Self-hosted license verification.
 *
 * Design rules (from the product spec):
 *  - A license is an Ed25519-signed JSON payload uploaded by the org.
 *  - Verification is OFFLINE. There is NO phone-home. If the license server is
 *    unreachable, or no license is present, or a license fails verification,
 *    Kinynx MUST keep working as Community Edition — never disabled.
 *  - Overrides on top of PLAN_DEFAULTS let sales negotiate custom caps.
 */

import { createPublicKey, verify as edVerify } from "node:crypto";
import {
  PLAN_DEFAULTS,
  type Entitlements,
  type FeatureFlags,
  type Limits,
  type Plan,
} from "./features.js";

export interface LicensePayload {
  license_id: string;
  organization_id: string;
  plan: Plan;
  issued_at: string; // ISO 8601
  expires_at: string | null; // ISO 8601 or null for perpetual
  user_limit?: number;
  /** Partial overrides applied on top of the plan defaults. */
  feature_flags?: Partial<FeatureFlags>;
  limits?: Partial<Limits>;
}

/** A license file is `{ "payload": {...}, "signature": "<base64 ed25519>" }`. */
export interface LicenseFile {
  payload: LicensePayload;
  signature: string;
}

export type LicenseVerdict =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: string };

/**
 * Verify a license file's signature and expiry.
 * Returns a verdict; callers decide entitlements via {@link entitlementsFor}.
 */
export function verifyLicense(
  file: LicenseFile,
  publicKeyBase64: string | undefined,
  now: Date = new Date(),
): LicenseVerdict {
  if (!publicKeyBase64) {
    return { valid: false, reason: "no license public key configured" };
  }
  let ok = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(canonicalJson(file.payload), "utf8");
    ok = edVerify(null, message, key, Buffer.from(file.signature, "base64"));
  } catch (err) {
    return { valid: false, reason: `signature check failed: ${(err as Error).message}` };
  }
  if (!ok) return { valid: false, reason: "invalid signature" };

  if (file.payload.expires_at) {
    const expiry = new Date(file.payload.expires_at);
    if (Number.isNaN(expiry.getTime())) {
      return { valid: false, reason: "malformed expires_at" };
    }
    if (expiry.getTime() < now.getTime()) {
      return { valid: false, reason: "license expired" };
    }
  }
  return { valid: true, payload: file.payload };
}

/**
 * Resolve the effective entitlements for a deployment.
 * With no valid license, returns Community defaults (graceful degradation).
 */
export function entitlementsFor(verdict: LicenseVerdict | null): Entitlements {
  if (!verdict || !verdict.valid) {
    return structuredClone(PLAN_DEFAULTS.community);
  }
  const base = structuredClone(PLAN_DEFAULTS[verdict.payload.plan]);
  const p = verdict.payload;
  if (typeof p.user_limit === "number") base.limits.max_users = p.user_limit;
  if (p.limits) Object.assign(base.limits, p.limits);
  if (p.feature_flags) Object.assign(base.features, p.feature_flags);
  return base;
}

/** Deterministic JSON with sorted keys, so signatures are reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
