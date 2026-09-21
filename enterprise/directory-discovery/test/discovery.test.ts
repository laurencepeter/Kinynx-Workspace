import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverConnections } from "../src/index.js";

test("managed device yields desktop auto sign-in recommendation", () => {
  const out = discoverConnections({ domain: "acme.com", managedDeviceHint: true });
  assert.equal(out[0]?.kind, "desktop-sso");
  assert.equal(out[0]?.autoSignInCapable, true);
});

test("Microsoft 365 MX is detected as Entra ID OIDC", () => {
  const out = discoverConnections({ domain: "acme.com", mxHosts: ["acme-com.mail.protection.outlook.com"] });
  assert.ok(out.some((c) => c.provider === "Microsoft Entra ID" && c.kind === "oidc"));
});

test("configured connection always wins with highest confidence", () => {
  const out = discoverConnections({
    domain: "acme.com",
    mxHosts: ["x.google.com"],
    configuredConnection: {
      provider: "Okta",
      kind: "saml",
      suggested: {},
      autoSignInCapable: true,
      confidence: "high",
      note: "",
    },
  });
  assert.equal(out[0]?.provider, "Okta");
  assert.equal(out[0]?.confidence, "configured");
});

test("unknown domain yields no recommendations (falls back to password)", () => {
  assert.deepEqual(discoverConnections({ domain: "nowhere.example" }), []);
});
