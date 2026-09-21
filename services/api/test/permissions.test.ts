import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCan, can, effectiveRole, ForbiddenError } from "@kinynx/permissions";
import {
  entitlementsFor,
  PLAN_DEFAULTS,
  verifyLicense,
  withinLimit,
  UNLIMITED,
  type LicenseFile,
} from "@kinynx/shared";

test("effectiveRole escalates to the highest grant", () => {
  assert.equal(effectiveRole("viewer", "admin"), "admin");
  assert.equal(effectiveRole(null, "editor"), "editor");
  assert.equal(effectiveRole(null, null), null);
  assert.equal(effectiveRole("owner", "viewer"), "owner");
});

test("can() enforces the required minimum role", () => {
  assert.equal(can("viewer", "page:read"), true);
  assert.equal(can("viewer", "page:update"), false);
  assert.equal(can("editor", "page:update"), true);
  assert.equal(can("editor", "org:delete"), false);
  assert.equal(can("owner", "org:delete"), true);
  assert.equal(can(null, "page:read"), false);
});

test("assertCan throws ForbiddenError when unauthorized", () => {
  assert.throws(() => assertCan("viewer", "page:delete"), ForbiddenError);
  assert.doesNotThrow(() => assertCan("admin", "workspace:create"));
});

test("Community entitlements keep every core feature", () => {
  const ent = entitlementsFor(null);
  assert.equal(ent.edition, "Community");
  assert.equal(ent.features.databases, true);
  assert.equal(ent.features.templates, true);
  assert.equal(ent.features.api, true);
  assert.equal(ent.features.sso_saml, false);
  assert.equal(ent.limits.max_users, UNLIMITED);
});

test("withinLimit treats UNLIMITED as always allowed", () => {
  assert.equal(withinLimit(UNLIMITED, 999999), true);
  assert.equal(withinLimit(10, 9), true);
  assert.equal(withinLimit(10, 10), false);
});

test("invalid/absent license degrades to Community, never disabled", () => {
  const bogus: LicenseFile = {
    payload: {
      license_id: "x",
      organization_id: "o",
      plan: "enterprise",
      issued_at: new Date().toISOString(),
      expires_at: null,
    },
    signature: "not-a-real-signature",
  };
  const verdict = verifyLicense(bogus, undefined);
  assert.equal(verdict.valid, false);
  assert.deepEqual(entitlementsFor(verdict).edition, "Community");
});

test("plan defaults are internally consistent", () => {
  assert.equal(PLAN_DEFAULTS.enterprise.features.sso_saml, true);
  assert.equal(PLAN_DEFAULTS.team.limits.max_users, 10);
});
