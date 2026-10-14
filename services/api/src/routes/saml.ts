import { SAML } from "@node-saml/node-saml";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { newRefreshToken, signAccessToken } from "../auth/tokens.js";

/**
 * SAML 2.0 SP-initiated SSO. XML signature verification is delegated to the
 * vetted @node-saml/node-saml library — never hand-rolled. Enabled when the IdP
 * entry point, SP issuer, and IdP signing certificate are configured.
 */
export async function registerSamlRoutes(app: FastifyInstance): Promise<void> {
  const cfg = app.config;
  const enabled = Boolean(cfg.SAML_ENTRY_POINT && cfg.SAML_ISSUER && cfg.SAML_IDP_CERT);
  const callbackUrl = cfg.SAML_CALLBACK_URL ?? `${cfg.PUBLIC_APP_URL}/api/auth/saml/callback`;

  const saml = enabled
    ? new SAML({
        entryPoint: cfg.SAML_ENTRY_POINT!,
        issuer: cfg.SAML_ISSUER!,
        idpCert: cfg.SAML_IDP_CERT!,
        callbackUrl,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: true,
      })
    : null;

  app.get("/api/auth/saml/status", async () => ({ enabled }));

  app.get("/api/auth/saml/metadata", async (_request, reply) => {
    if (!saml) return reply.code(404).send({ error: "SAML not configured" });
    reply.header("content-type", "application/xml");
    return reply.send(saml.generateServiceProviderMetadata(null, cfg.SAML_IDP_CERT ?? null));
  });

  app.get("/api/auth/saml/login", async (request, reply) => {
    if (!saml) return reply.code(404).send({ error: "SAML not configured" });
    const url = await saml.getAuthorizeUrlAsync("", request.headers.host ?? "", {});
    return reply.send({ url });
  });

  // Assertion Consumer Service (ACS). Body is form-encoded (SAMLResponse=...).
  app.post("/api/auth/saml/callback", async (request, reply) => {
    if (!saml) return reply.code(404).send({ error: "SAML not configured" });
    const body = z.object({ SAMLResponse: z.string(), RelayState: z.string().optional() }).parse(request.body);
    let email: string | undefined;
    try {
      const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: body.SAMLResponse });
      email = (profile?.email as string) || (profile?.nameID as string);
    } catch (err) {
      app.log.warn(`SAML validation failed: ${(err as Error).message}`);
      return reply.code(401).send({ error: "invalid SAML response" });
    }
    if (!email) return reply.code(401).send({ error: "SAML assertion had no email/nameID" });

    let user = (await query<{ id: string; email: string }>(app.db, "SELECT id, email FROM users WHERE email_norm = lower($1)", [email]))[0];
    if (!user) {
      user = (await query<{ id: string; email: string }>(app.db, "INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id, email", [email, email.split("@")[0]]))[0]!;
    }
    const accessToken = await signAccessToken({ sub: user.id, email: user.email }, cfg.JWT_SECRET, cfg.ACCESS_TOKEN_TTL);
    const refresh = newRefreshToken();
    await query(app.db, "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)", [user.id, refresh.hash, new Date(Date.now() + cfg.REFRESH_TOKEN_TTL * 1000)]);
    return reply.send({ user: { id: user.id, email: user.email }, access_token: accessToken, refresh_token: refresh.raw, token_type: "Bearer", expires_in: cfg.ACCESS_TOKEN_TTL });
  });
}
