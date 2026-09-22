import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { hashToken, newRefreshToken, signAccessToken } from "../auth/tokens.js";
import { generateSecret, otpauthUri, verifyTotp } from "../auth/totp.js";

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
  display_name: z.string().max(120).optional(),
});

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  mfa_secret?: string | null;
  mfa_enabled?: boolean;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app;

  async function issueSession(user: { id: string; email: string }, ua?: string, ip?: string) {
    const accessToken = await signAccessToken(
      { sub: user.id, email: user.email },
      config.JWT_SECRET,
      config.ACCESS_TOKEN_TTL,
    );
    const refresh = newRefreshToken();
    const expires = new Date(Date.now() + config.REFRESH_TOKEN_TTL * 1000);
    await query(
      app.db,
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, refresh.hash, ua ?? null, ip ?? null, expires],
    );
    return {
      access_token: accessToken,
      refresh_token: refresh.raw,
      token_type: "Bearer",
      expires_in: config.ACCESS_TOKEN_TTL,
    };
  }

  // Stricter per-route throttles on credential endpoints (brute-force defense),
  // layered under the global limiter.
  const tight = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

  // POST /api/auth/register — email/password sign-up.
  app.post("/api/auth/register", tight(30), async (request, reply) => {
    const body = credentials.parse(request.body);
    const existing = await query<UserRow>(app.db, "SELECT id FROM users WHERE email_norm = lower($1)", [
      body.email,
    ]);
    if (existing.length > 0) return reply.code(409).send({ error: "email already registered" });

    const passwordHash = await hashPassword(body.password);
    const rows = await query<UserRow>(
      app.db,
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1,$2,$3) RETURNING id, email, display_name, password_hash`,
      [body.email, body.display_name ?? body.email.split("@")[0], passwordHash],
    );
    const user = rows[0]!;
    const session = await issueSession(user, request.headers["user-agent"], request.ip);
    return reply.code(201).send({ user: { id: user.id, email: user.email }, ...session });
  });

  // POST /api/auth/login
  app.post("/api/auth/login", tight(20), async (request, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string(), code: z.string().optional() }).parse(request.body);
    const rows = await query<UserRow>(
      app.db,
      "SELECT id, email, display_name, password_hash, mfa_secret, mfa_enabled FROM users WHERE email_norm = lower($1) AND is_active",
      [body.email],
    );
    const user = rows[0];
    // Constant-ish behavior: always run a verify to reduce user-enumeration timing.
    const ok = user?.password_hash
      ? await verifyPassword(user.password_hash, body.password)
      : await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000", body.password);
    if (!user || !ok) return reply.code(401).send({ error: "invalid credentials" });

    // Second factor when enrolled.
    if (user.mfa_enabled && user.mfa_secret) {
      if (!body.code) return reply.code(401).send({ error: "mfa code required", mfa_required: true });
      if (!verifyTotp(user.mfa_secret, body.code)) return reply.code(401).send({ error: "invalid mfa code", mfa_required: true });
    }

    const session = await issueSession(user, request.headers["user-agent"], request.ip);
    return reply.send({ user: { id: user.id, email: user.email }, ...session });
  });

  // ── MFA (TOTP) enrollment ───────────────────────────────────────────────
  // Begin setup: generate a secret (stored, not yet active) + an otpauth URI.
  app.post("/api/auth/mfa/setup", { preHandler: app.authenticate }, async (request, reply) => {
    const secret = generateSecret();
    await query(app.db, "UPDATE users SET mfa_secret=$2, mfa_enabled=FALSE WHERE id=$1", [request.user!.id, secret]);
    return reply.send({ secret, otpauth_uri: otpauthUri(secret, request.user!.email) });
  });

  // Confirm setup with a code from the authenticator app.
  app.post("/api/auth/mfa/enable", { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { code } = z.object({ code: z.string() }).parse(request.body);
    const secret = (await query<{ mfa_secret: string | null }>(app.db, "SELECT mfa_secret FROM users WHERE id=$1", [request.user!.id]))[0]?.mfa_secret;
    if (!secret) return reply.code(400).send({ error: "run /mfa/setup first" });
    if (!verifyTotp(secret, code)) return reply.code(400).send({ error: "invalid code" });
    await query(app.db, "UPDATE users SET mfa_enabled=TRUE WHERE id=$1", [request.user!.id]);
    return reply.send({ ok: true });
  });

  // Disable MFA (requires a current code).
  app.post("/api/auth/mfa/disable", { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { code } = z.object({ code: z.string() }).parse(request.body);
    const secret = (await query<{ mfa_secret: string | null }>(app.db, "SELECT mfa_secret FROM users WHERE id=$1 AND mfa_enabled", [request.user!.id]))[0]?.mfa_secret;
    if (!secret) return reply.code(400).send({ error: "mfa not enabled" });
    if (!verifyTotp(secret, code)) return reply.code(400).send({ error: "invalid code" });
    await query(app.db, "UPDATE users SET mfa_enabled=FALSE, mfa_secret=NULL WHERE id=$1", [request.user!.id]);
    return reply.code(204).send();
  });

  // POST /api/auth/refresh — rotate refresh token.
  app.post("/api/auth/refresh", async (request, reply) => {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(request.body);
    const hash = hashToken(refresh_token);
    const rows = await query<{ id: string; user_id: string; email: string }>(
      app.db,
      `SELECT rt.id, rt.user_id, u.email
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
      [hash],
    );
    const token = rows[0];
    if (!token) return reply.code(401).send({ error: "invalid refresh token" });
    // Rotate: revoke old, issue new.
    await query(app.db, "UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [token.id]);
    const session = await issueSession({ id: token.user_id, email: token.email });
    return reply.send(session);
  });

  // POST /api/auth/logout — revoke a refresh token.
  app.post("/api/auth/logout", async (request, reply) => {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(request.body);
    await query(app.db, "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [
      hashToken(refresh_token),
    ]);
    return reply.code(204).send();
  });

  // POST /api/auth/magic-link/request — passwordless sign-in.
  // Always returns 200 (no user enumeration). Emails a single-use link.
  app.post("/api/auth/magic-link/request", tight(10), async (request, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body);
    const raw = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await query(app.db, "INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1,$2,$3)", [email, hashToken(raw), expires]);
    const link = `${config.PUBLIC_APP_URL}/auth/magic/${raw}`;
    await app.email
      .send({ to: email, subject: "Your Kinynx sign-in link", html: `<p>Click to sign in (valid 15 minutes):</p><p><a href="${link}">${link}</a></p>` })
      .catch((err) => app.log.warn(`magic-link email failed: ${(err as Error).message}`));
    // Dev convenience: expose the link only when using the console email driver
    // (no real inbox). Never returned once a real email provider is configured.
    return reply.send(config.EMAIL_DRIVER === "console" ? { ok: true, dev_link: link } : { ok: true });
  });

  // POST /api/auth/magic-link/verify — redeem the token, create the user if new.
  app.post("/api/auth/magic-link/verify", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(request.body);
    const row = (
      await query<{ id: string; email: string }>(
        app.db,
        "SELECT id, email FROM magic_links WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()",
        [hashToken(token)],
      )
    )[0];
    if (!row) return reply.code(400).send({ error: "invalid or expired link" });
    await query(app.db, "UPDATE magic_links SET used_at = now() WHERE id=$1", [row.id]);

    let user = (await query<UserRow>(app.db, "SELECT id, email, display_name, password_hash FROM users WHERE email_norm = lower($1)", [row.email]))[0];
    if (!user) {
      user = (await query<UserRow>(app.db, "INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id, email, display_name, password_hash", [row.email, row.email.split("@")[0]]))[0]!;
    }
    const session = await issueSession(user, request.headers["user-agent"], request.ip);
    return reply.send({ user: { id: user.id, email: user.email }, ...session });
  });

  // GET /api/auth/me
  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => {
    const rows = await query<UserRow>(
      app.db,
      "SELECT id, email, display_name, password_hash FROM users WHERE id = $1",
      [request.user!.id],
    );
    const u = rows[0]!;
    return { id: u.id, email: u.email, display_name: u.display_name };
  });
}
