import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

// Throwaway self-signed IdP certificate (test only).
const IDP_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIDBzCCAe+gAwIBAgIUK/kp1MsQl9j10Kt511Wd/ralEl8wDQYJKoZIhvcNAQEL\nBQAwEzERMA8GA1UEAwwIdGVzdC1pZHAwHhcNMjYwOTIyMDcyNjA3WhcNMzYwOTE5\nMDcyNjA3WjATMREwDwYDVQQDDAh0ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQAD\nggEPADCCAQoCggEBAKdzLv41ygLBC8mBjsPYSyZuG6M7U+sUULewOoqT/6hZfvEO\nOvv5yTbtw8sRxyas76hrQgzywYok2LKaYKG06oX4AXJ3CySC3c9s2Tfyetx13Q55\nnZvS0iND6b8U5jk0FKY/3Bnv/I5mvmBm/MAo4anWtnJDpaqu6LTidxtWnzGeVsEC\na1G+q6jpWWZeox0F8IIGzidonnrWKIY49XoA9pLpIiu6aIcUu+orI/s3cVb/rWsh\nJNO0j5W3dzxZk0MnDew8ry+ENq2JgWJnYkYd9FpHZ9K889WxTOIGSeEPqe08uxAA\nCVQkkkTfBMO2RNmDSf7oaTGybqEzgLteYhwC01MCAwEAAaNTMFEwHQYDVR0OBBYE\nFICBG9sybEkPPYWxwE9rD8tfKukhMB8GA1UdIwQYMBaAFICBG9sybEkPPYWxwE9r\nD8tfKukhMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAHvqD4JR\nYkKlynEJm4rRw9cAFKnR2Ju1L9xHN6Uj89HPbTFaHeQsy+BcjoQG1TtDdAbwsb/P\nvnXIr9QdinnLwv0E8bI7pCzrs0dPxeHagzK1DMGGM1hTjdzV8I5QUEunC3LO4dFZ\nz4h3ihhMc7+sfibPSxJv50TeBTKBPQbgqlNIUJlliRMJv2tReUhnuFFqr58VV/E0\nNUGtNS2wSgPyqAJzitE/LOiT4WlWi2ajilK+bqOijfqocWBv4b3UahTsShnZrNSI\noIwyOLZtW3PmQ5Zrq7We00r2/ARemMB6vq9o/bxPlzF2Xep57PEk0386AT8WD0FW\n89QWTp62L387OQQ=\n-----END CERTIFICATE-----\n";

let app: FastifyInstance | undefined;
let ready = false;
try {
  const env = {
    ...process.env,
    SAML_ENTRY_POINT: "https://idp.example.com/sso",
    SAML_ISSUER: "kinynx-sp",
    SAML_IDP_CERT: IDP_CERT,
    SAML_CALLBACK_URL: "http://localhost/api/auth/saml/callback",
  };
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig(env));
  ready = true;
} catch (err) {
  console.warn(`[saml.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = ready ? false : "requires Postgres";

test("SAML status is enabled when configured", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/auth/saml/status" });
  assert.equal(res.json().enabled, true);
});

test("SP metadata is served as XML", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/auth/saml/metadata" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /EntityDescriptor/);
});

test("login builds a redirect to the IdP with a SAMLRequest", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/auth/saml/login" });
  assert.equal(res.statusCode, 200);
  const url = new URL(res.json().url);
  assert.equal(url.origin + url.pathname, "https://idp.example.com/sso");
  assert.ok(url.searchParams.get("SAMLRequest"));
});

test("callback rejects an unsigned/garbage SAML response", { skip }, async () => {
  const res = await app!.inject({
    method: "POST",
    url: "/api/auth/saml/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `SAMLResponse=${encodeURIComponent(Buffer.from("<not-a-real-assertion/>").toString("base64"))}`,
  });
  assert.equal(res.statusCode, 401);
  // Let node-saml's internal async validation fully settle before teardown.
  await new Promise((r) => setTimeout(r, 300));
});
