import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { generateSecret, totpCode, verifyTotp } from "../src/auth/totp.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

// ── Pure TOTP unit tests ─────────────────────────────────────────────────────
test("totpCode is deterministic and verifyTotp accepts it", () => {
  const secret = generateSecret();
  const t = 1_700_000_000_000;
  const code = totpCode(secret, t);
  assert.match(code, /^\d{6}$/);
  assert.equal(totpCode(secret, t), code);
  assert.equal(verifyTotp(secret, code, t), true);
  assert.equal(verifyTotp(secret, "000000", t), code === "000000");
  // Within the ±1 step drift window.
  assert.equal(verifyTotp(secret, totpCode(secret, t - 30_000), t), true);
  // Two steps away is rejected.
  assert.equal(verifyTotp(secret, totpCode(secret, t - 90_000), t), false);
});

// ── Integration ──────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";
let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  dbAvailable = true;
} catch (err) {
  console.warn(`[mfa.test] skipping integration: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

test("enroll TOTP, then login requires the second factor", { skip }, async () => {
  const email = `mfa${s}@ex.com`;
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "supersecret1" } });
  const token = reg.json().access_token as string;

  const setup = await app!.inject({ method: "POST", url: "/api/auth/mfa/setup", headers: auth(token) });
  const secret = setup.json().secret as string;
  assert.ok(setup.json().otpauth_uri.startsWith("otpauth://totp/"));

  // Enable with a valid code.
  const enable = await app!.inject({ method: "POST", url: "/api/auth/mfa/enable", headers: auth(token), payload: { code: totpCode(secret) } });
  assert.equal(enable.statusCode, 200);

  // Login without a code is now rejected.
  const noCode = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "supersecret1" } });
  assert.equal(noCode.statusCode, 401);
  assert.equal(noCode.json().mfa_required, true);

  // Login with a valid code succeeds.
  const withCode = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "supersecret1", code: totpCode(secret) } });
  assert.equal(withCode.statusCode, 200);
  assert.ok(withCode.json().access_token);

  // Disable, then login works without a code again.
  const disable = await app!.inject({ method: "POST", url: "/api/auth/mfa/disable", headers: auth(token), payload: { code: totpCode(secret) } });
  assert.equal(disable.statusCode, 204);
  const plain = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "supersecret1" } });
  assert.equal(plain.statusCode, 200);
});
