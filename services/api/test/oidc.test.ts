import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

const ssoEmail = `sso${Date.now()}@corp.com`;
let idp: Server | undefined;
let app: FastifyInstance | undefined;
let ready = false;
try {
  // Mock OIDC provider: /token then /userinfo.
  idp = createServer((req, res) => {
    if (req.url?.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "mock-access-token", token_type: "Bearer" }));
    } else if (req.url?.startsWith("/userinfo")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ email: ssoEmail, name: "SSO User" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => idp!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(idp!.address() as AddressInfo).port}`;
  const env = {
    ...process.env,
    OIDC_CLIENT_ID: "kinynx-test",
    OIDC_CLIENT_SECRET: "secret",
    OIDC_AUTH_URL: `${base}/authorize`,
    OIDC_TOKEN_URL: `${base}/token`,
    OIDC_USERINFO_URL: `${base}/userinfo`,
    OIDC_REDIRECT_URI: "http://localhost/api/auth/oidc/callback",
  };
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig(env));
  ready = true;
} catch (err) {
  console.warn(`[oidc.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  if (idp) await new Promise<void>((r) => idp!.close(() => r()));
  await closePool();
});
const skip = ready ? false : "requires Postgres";

test("OIDC status reports enabled when configured", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/auth/oidc/status" });
  assert.equal(res.json().enabled, true);
});

test("OIDC login → callback issues a session and provisions the user", { skip }, async () => {
  const login = await app!.inject({ method: "GET", url: "/api/auth/oidc/login" });
  assert.equal(login.statusCode, 200);
  const url = new URL(login.json().url);
  const state = url.searchParams.get("state")!;
  assert.ok(state);
  assert.equal(url.searchParams.get("client_id"), "kinynx-test");

  const cb = await app!.inject({ method: "GET", url: `/api/auth/oidc/callback?code=any-code&state=${encodeURIComponent(state)}` });
  assert.equal(cb.statusCode, 200);
  assert.equal(cb.json().user.email, ssoEmail);
  const token = cb.json().access_token as string;

  const me = await app!.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.json().email, ssoEmail);
});

test("OIDC callback rejects a forged state", { skip }, async () => {
  const cb = await app!.inject({ method: "GET", url: "/api/auth/oidc/callback?code=x&state=not-a-valid-jwt" });
  assert.equal(cb.statusCode, 400);
});
