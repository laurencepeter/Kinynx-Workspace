/**
 * Deployment-level entitlement resolution.
 * Loads an optional license file at startup and verifies it OFFLINE. If it is
 * missing/invalid/expired, we run as Community Edition — never disabled.
 */
import { readFileSync } from "node:fs";
import {
  entitlementsFor,
  verifyLicense,
  type Entitlements,
  type LicenseFile,
} from "@kinynx/shared";
import type { Config } from "./config.js";

export function resolveEntitlements(config: Config): Entitlements {
  if (!config.KINYNX_LICENSE_FILE) {
    return entitlementsFor(null); // Community defaults
  }
  try {
    const raw = readFileSync(config.KINYNX_LICENSE_FILE, "utf8");
    const file = JSON.parse(raw) as LicenseFile;
    const verdict = verifyLicense(file, config.KINYNX_LICENSE_PUBLIC_KEY);
    if (!verdict.valid) {
      console.warn(`[license] ignoring license: ${verdict.reason}. Running Community Edition.`);
      return entitlementsFor(null);
    }
    console.log(`[license] Enterprise Edition (${verdict.payload.plan}) active`);
    return entitlementsFor(verdict);
  } catch (err) {
    console.warn(`[license] could not load license (${(err as Error).message}). Community Edition.`);
    return entitlementsFor(null);
  }
}
