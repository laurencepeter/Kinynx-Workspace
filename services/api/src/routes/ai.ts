import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { pageRole } from "../access.js";
import { rewritePrompt, summarizePrompt } from "../ai/index.js";

/**
 * Workspace AI features on top of the provider abstraction. If no provider is
 * configured, endpoints return 503. If the deployment policy forbids external
 * providers (Enterprise data-control), external calls return 403.
 */
export async function registerAIRoutes(app: FastifyInstance): Promise<void> {
  const guard = (reply: import("fastify").FastifyReply): boolean => {
    if (!app.ai) {
      reply.code(503).send({ error: "AI is not configured for this deployment" });
      return false;
    }
    if (app.ai.external && !app.config.AI_ALLOW_EXTERNAL) {
      reply.code(403).send({ error: "external AI providers are disabled by policy" });
      return false;
    }
    return true;
  };

  app.get("/api/ai/status", async () => ({
    enabled: app.ai != null,
    provider: app.ai?.name ?? null,
    external: app.ai?.external ?? false,
    external_allowed: app.config.AI_ALLOW_EXTERNAL,
  }));

  app.post("/api/ai/summarize", { preHandler: app.authenticate }, async (request, reply) => {
    const { page_id } = z.object({ page_id: z.string().uuid() }).parse(request.body);
    assertCan(await pageRole(app.db, request.user!.id, page_id), "page:read");
    if (!guard(reply)) return reply;

    const page = (await query<{ title: string }>(app.db, "SELECT title FROM pages WHERE id=$1", [page_id]))[0];
    if (!page) return reply.code(404).send({ error: "not found" });
    const blocks = await query<{ content: Record<string, unknown> }>(app.db, "SELECT content FROM blocks WHERE page_id=$1 ORDER BY position", [page_id]);
    const text = `# ${page.title}\n\n` + blocks.map((b) => String(b.content.text ?? b.content.code ?? "")).filter(Boolean).join("\n");

    const { text: summary } = await app.ai!.complete(summarizePrompt(text));
    return reply.send({ summary });
  });

  app.post("/api/ai/rewrite", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z.object({ text: z.string().min(1).max(20000), instruction: z.string().min(1).max(500) }).parse(request.body);
    if (!guard(reply)) return reply;
    const { text } = await app.ai!.complete(rewritePrompt(body.text, body.instruction));
    return reply.send({ text });
  });

  app.post("/api/ai/complete", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z.object({ system: z.string().max(4000).optional(), prompt: z.string().min(1).max(20000), max_tokens: z.number().int().min(1).max(4096).optional() }).parse(request.body);
    if (!guard(reply)) return reply;
    const { text } = await app.ai!.complete({ system: body.system, prompt: body.prompt, maxTokens: body.max_tokens });
    return reply.send({ text });
  });
}
