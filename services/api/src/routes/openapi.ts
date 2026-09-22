import type { FastifyInstance } from "fastify";

/**
 * Serves an OpenAPI 3.1 description of the API at /api/openapi.json and a tiny
 * viewer at /api/docs. Kept curated (not auto-generated) so it stays a stable
 * contract; the route tables in docs/API.md are the human companion.
 */
export async function registerOpenApiRoutes(app: FastifyInstance): Promise<void> {
  const bearer = [{ bearerAuth: [] }];
  const ok = { description: "Success" };
  const doc = {
    openapi: "3.1.0",
    info: { title: "Kinynx API", version: "0.1.0", description: "Open-source collaborative workspace API." },
    servers: [{ url: app.config.PUBLIC_APP_URL }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    },
    paths: {
      "/health": { get: { summary: "Liveness + dependency health", responses: { "200": ok } } },
      "/api/system/info": { get: { summary: "Edition, plan, features, limits", responses: { "200": ok } } },
      "/api/auth/register": { post: { summary: "Register (email/password)", responses: { "201": ok } } },
      "/api/auth/login": { post: { summary: "Login", responses: { "200": ok } } },
      "/api/auth/refresh": { post: { summary: "Rotate refresh token", responses: { "200": ok } } },
      "/api/auth/me": { get: { summary: "Current user", security: bearer, responses: { "200": ok } } },
      "/api/organizations": {
        get: { summary: "List my organizations", security: bearer, responses: { "200": ok } },
        post: { summary: "Create organization", security: bearer, responses: { "201": ok } },
      },
      "/api/organizations/{orgId}/workspaces": {
        get: { summary: "List workspaces", security: bearer, responses: { "200": ok } },
        post: { summary: "Create workspace", security: bearer, responses: { "201": ok } },
      },
      "/api/organizations/{orgId}/groups": {
        get: { summary: "List groups", security: bearer, responses: { "200": ok } },
        post: { summary: "Create group", security: bearer, responses: { "201": ok } },
      },
      "/api/organizations/{orgId}/invitations": { post: { summary: "Invite by email or link", security: bearer, responses: { "201": ok } } },
      "/api/invitations/accept": { post: { summary: "Accept an invitation", security: bearer, responses: { "200": ok } } },
      "/api/workspaces/{workspaceId}/pages": {
        get: { summary: "List pages", security: bearer, responses: { "200": ok } },
        post: { summary: "Create page", security: bearer, responses: { "201": ok } },
      },
      "/api/pages/{id}": {
        get: { summary: "Get page + blocks", security: bearer, responses: { "200": ok } },
        patch: { summary: "Update page", security: bearer, responses: { "200": ok } },
        delete: { summary: "Archive page", security: bearer, responses: { "204": { description: "No content" } } },
      },
      "/api/pages/{id}/blocks": { post: { summary: "Add block", security: bearer, responses: { "201": ok } } },
      "/api/pages/{id}/versions": {
        get: { summary: "Version history", security: bearer, responses: { "200": ok } },
        post: { summary: "Snapshot version", security: bearer, responses: { "201": ok } },
      },
      "/api/pages/{id}/publish": { post: { summary: "Publish public page", security: bearer, responses: { "201": ok } } },
      "/api/public/{slug}": { get: { summary: "Read a published page (public)", responses: { "200": ok } } },
      "/api/pages/{id}/export": { get: { summary: "Export page subtree (portable JSON)", security: bearer, responses: { "200": ok } } },
      "/api/workspaces/{workspaceId}/import": { post: { summary: "Import portable JSON", security: bearer, responses: { "201": ok } } },
      "/api/workspaces/{workspaceId}/databases": {
        get: { summary: "List databases", security: bearer, responses: { "200": ok } },
        post: { summary: "Create database", security: bearer, responses: { "201": ok } },
      },
      "/api/databases/{id}/records": {
        get: { summary: "List records", security: bearer, responses: { "200": ok } },
        post: { summary: "Create record", security: bearer, responses: { "201": ok } },
      },
      "/api/databases/{id}/report": { get: { summary: "Status counts + progress rollup", security: bearer, responses: { "200": ok } } },
      "/api/comments": {
        get: { summary: "List comments for a target", security: bearer, responses: { "200": ok } },
        post: { summary: "Add comment (with @mentions)", security: bearer, responses: { "201": ok } },
      },
      "/api/notifications": { get: { summary: "My notifications", security: bearer, responses: { "200": ok } } },
      "/api/workspaces/{workspaceId}/files": { post: { summary: "Create file metadata + upload target", security: bearer, responses: { "201": ok } } },
      "/api/files/{id}": { get: { summary: "File metadata + download URL", security: bearer, responses: { "200": ok } } },
      "/api/search": { get: { summary: "Full-text search", security: bearer, responses: { "200": ok } } },
    },
  };

  app.get("/api/openapi.json", async () => doc);

  app.get("/api/docs", async (_req, reply) => {
    reply.header("content-type", "text/html");
    return reply.send(`<!doctype html><html><head><meta charset="utf-8"><title>Kinynx API</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0"><redoc spec-url="/api/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script></body></html>`);
  });
}
