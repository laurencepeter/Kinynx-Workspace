import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { hashToken, newRefreshToken, signAccessToken } from "../auth/tokens.js";

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

  // POST /api/auth/register — email/password sign-up.
  app.post("/api/auth/register", async (request, reply) => {
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
  app.post("/api/auth/login", async (request, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(request.body);
    const rows = await query<UserRow>(
      app.db,
      "SELECT id, email, display_name, password_hash FROM users WHERE email_norm = lower($1) AND is_active",
      [body.email],
    );
    const user = rows[0];
    // Constant-ish behavior: always run a verify to reduce user-enumeration timing.
    const ok = user?.password_hash
      ? await verifyPassword(user.password_hash, body.password)
      : await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000", body.password);
    if (!user || !ok) return reply.code(401).send({ error: "invalid credentials" });

    const session = await issueSession(user, request.headers["user-agent"], request.ip);
    return reply.send({ user: { id: user.id, email: user.email }, ...session });
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
