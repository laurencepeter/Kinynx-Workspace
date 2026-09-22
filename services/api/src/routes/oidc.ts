import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SignJWT, jwtVerify } from "jose";
import { query } from "../db/pool.js";
import { newRefreshToken, signAccessToken } from "../auth/tokens.js";

/**
 * Generic OIDC / OAuth2 authorization-code sign-in. One implementation serves
 * Community OAuth and Enterprise OIDC (Authentik, Keycloak, Google, Okta,
 * Entra ID, …). SAML is a separate enterprise connector; OIDC covers most IdPs.
 *
 * State is a short-lived signed JWT (no server-side session store needed). On
 * callback we exchange the code, read userinfo, then find-or-create the user by
 * email and issue the standard Kinynx session.
 */
export async function registerOidcRoutes(app: FastifyInstance): Promise<void> {
  const cfg = app.config;
  const enabled = Boolean(cfg.OIDC_CLIENT_ID && cfg.OIDC_AUTH_URL && cfg.OIDC_TOKEN_URL && cfg.OIDC_USERINFO_URL);

  app.get("/api/auth/oidc/status", async () => ({ enabled }));

  // Begin login: returns the IdP authorize URL (client redirects the browser).
  app.get("/api/auth/oidc/login", async (_request, reply) => {
    if (!enabled) return reply.code(404).send({ error: "OIDC not configured" });
    const nonce = randomBytes(16).toString("hex");
    const state = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .setIssuer("kinynx-oidc")
      .sign(new TextEncoder().encode(cfg.JWT_SECRET));
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.OIDC_CLIENT_ID!,
      redirect_uri: cfg.OIDC_REDIRECT_URI ?? `${cfg.PUBLIC_APP_URL}/api/auth/oidc/callback`,
      scope: cfg.OIDC_SCOPES,
      state,
    });
    return reply.send({ url: `${cfg.OIDC_AUTH_URL}?${params.toString()}` });
  });

  // Callback: exchange code → userinfo → session.
  app.get("/api/auth/oidc/callback", async (request, reply) => {
    if (!enabled) return reply.code(404).send({ error: "OIDC not configured" });
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(request.query);
    try {
      await jwtVerify(state, new TextEncoder().encode(cfg.JWT_SECRET), { issuer: "kinynx-oidc" });
    } catch {
      return reply.code(400).send({ error: "invalid state" });
    }

    // Authorization-code exchange.
    const tokenRes = await fetch(cfg.OIDC_TOKEN_URL!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.OIDC_REDIRECT_URI ?? `${cfg.PUBLIC_APP_URL}/api/auth/oidc/callback`,
        client_id: cfg.OIDC_CLIENT_ID!,
        client_secret: cfg.OIDC_CLIENT_SECRET ?? "",
      }),
    });
    if (!tokenRes.ok) return reply.code(401).send({ error: "token exchange failed" });
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) return reply.code(401).send({ error: "no access token" });

    const userRes = await fetch(cfg.OIDC_USERINFO_URL!, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!userRes.ok) return reply.code(401).send({ error: "userinfo failed" });
    const info = (await userRes.json()) as { email?: string; name?: string; preferred_username?: string };
    const email = info.email;
    if (!email) return reply.code(401).send({ error: "IdP did not return an email" });

    let user = (await query<{ id: string; email: string }>(app.db, "SELECT id, email FROM users WHERE email_norm = lower($1)", [email]))[0];
    if (!user) {
      user = (await query<{ id: string; email: string }>(app.db, "INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id, email", [email, info.name ?? info.preferred_username ?? email.split("@")[0]]))[0]!;
    }

    const accessToken = await signAccessToken({ sub: user.id, email: user.email }, cfg.JWT_SECRET, cfg.ACCESS_TOKEN_TTL);
    const refresh = newRefreshToken();
    await query(app.db, "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)", [user.id, refresh.hash, new Date(Date.now() + cfg.REFRESH_TOKEN_TTL * 1000)]);
    return reply.send({ user: { id: user.id, email: user.email }, access_token: accessToken, refresh_token: refresh.raw, token_type: "Bearer", expires_in: cfg.ACCESS_TOKEN_TTL });
  });
}
