import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ForbiddenError } from "@kinynx/permissions";
import type { Config } from "./config.js";
import { getPool } from "./db/pool.js";
import { resolveEntitlements } from "./licensing.js";
import { verifyAccessToken } from "./auth/tokens.js";
import { createEmailProvider } from "./email/index.js";
import { RealtimeHub } from "./realtime/hub.js";
import { createRealtimeBus } from "./realtime/bus.js";
import { createStorageDriver } from "./storage/index.js";
import { EventBus } from "./automation/events.js";
import { AutomationEngine } from "./automation/engine.js";
import { createAIProvider } from "./ai/index.js";
import { createBillingProvider } from "./billing/index.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOrgRoutes } from "./routes/organizations.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerBlockRoutes } from "./routes/blocks.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerDatabaseRoutes } from "./routes/databases.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerPortabilityRoutes } from "./routes/portability.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { registerCommentRoutes } from "./routes/comments.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerPublishingRoutes } from "./routes/publishing.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerOpenApiRoutes } from "./routes/openapi.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerAIRoutes } from "./routes/ai.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerOidcRoutes } from "./routes/oidc.js";
import { registerSamlRoutes } from "./routes/saml.js";
import { registerRoleRoutes } from "./routes/roles.js";
import { registerComplianceRoutes } from "./routes/compliance.js";
import { registerSecurityRoutes } from "./routes/security.js";
import { registerScimRoutes } from "./routes/scim.js";
import { enforceOrgSecurity } from "./security/policy.js";
import "./types.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.PUBLIC_APP_URL, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(websocket);
  await app.register(formbody); // SAML ACS posts form-encoded SAMLResponse

  app.decorate("db", getPool(config.DATABASE_URL));
  app.decorate("config", config);
  app.decorate("entitlements", resolveEntitlements(config));
  app.decorate("email", createEmailProvider(config));
  app.decorate("storage", await createStorageDriver(config));
  app.decorate("ai", createAIProvider(config));
  app.decorate("billing", createBillingProvider(config));
  const bus = await createRealtimeBus(config.REDIS_URL);
  app.decorate("hub", new RealtimeHub(bus));

  // Domain event bus → automation engine (WHEN trigger THEN actions).
  const events = new EventBus();
  new AutomationEngine(getPool(config.DATABASE_URL), createEmailProvider(config)).attach(events);
  app.decorate("events", events);

  app.addHook("onClose", async () => {
    await bus.close();
  });

  // Raw binary body for direct file uploads (metadata comes from the files row).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

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
        return;
      }
      // Enterprise org security policies (IP allowlist / required MFA).
      const violation = await enforceOrgSecurity(app.db, request.user.id, request.url, request.ip);
      if (violation) {
        request.user = undefined;
        await reply.code(violation.code).send(violation.body);
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
  await app.register(registerGroupRoutes);
  await app.register(registerInvitationRoutes);
  await app.register(registerDatabaseRoutes);
  await app.register(registerHistoryRoutes);
  await app.register(registerPortabilityRoutes);
  await app.register(registerCommentRoutes);
  await app.register(registerNotificationRoutes);
  await app.register(registerPublishingRoutes);
  await app.register(registerFileRoutes);
  await app.register(registerOpenApiRoutes);
  await app.register(registerAutomationRoutes);
  await app.register(registerIntegrationRoutes);
  await app.register(registerAIRoutes);
  await app.register(registerAdminRoutes);
  await app.register(registerBillingRoutes);
  await app.register(registerTemplateRoutes);
  await app.register(registerOidcRoutes);
  await app.register(registerSamlRoutes);
  await app.register(registerRoleRoutes);
  await app.register(registerComplianceRoutes);
  await app.register(registerSecurityRoutes);
  await app.register(registerScimRoutes);
  await app.register(registerRealtimeRoutes);

  return app;
}
