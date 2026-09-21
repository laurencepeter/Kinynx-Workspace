import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ForbiddenError } from "@kinynx/permissions";
import type { Config } from "./config.js";
import { getPool } from "./db/pool.js";
import { resolveEntitlements } from "./licensing.js";
import { verifyAccessToken } from "./auth/tokens.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOrgRoutes } from "./routes/organizations.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerBlockRoutes } from "./routes/blocks.js";
import { registerSystemRoutes } from "./routes/system.js";
import "./types.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.PUBLIC_APP_URL, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.decorate("db", getPool(config.DATABASE_URL));
  app.decorate("config", config);
  app.decorate("entitlements", resolveEntitlements(config));

  app.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        await reply.code(401).send({ error: "missing bearer token" });
        return;
      }
      try {
        const claims = await verifyAccessToken(header.slice(7), config.JWT_SECRET);
        request.user = { id: claims.sub, email: claims.email };
      } catch {
        await reply.code(401).send({ error: "invalid or expired token" });
      }
    },
  );

  // Centralized error shaping (never leak internals).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.message });
    const message = err instanceof Error ? err.message : "error";
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: "validation failed", details: message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal error" : message });
  });

  await app.register(registerSystemRoutes);
  await app.register(registerAuthRoutes);
  await app.register(registerOrgRoutes);
  await app.register(registerWorkspaceRoutes);
  await app.register(registerPageRoutes);
  await app.register(registerBlockRoutes);

  return app;
}
