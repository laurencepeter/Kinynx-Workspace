/**
 * Automation actions. Each action is `{ type, config }`; runAction executes one
 * against a domain event. New action types are added here without touching the
 * engine — the "integration framework rather than hard-coded integrations".
 */
import { createHmac } from "node:crypto";
import type pg from "pg";
import { query } from "../db/pool.js";
import type { EmailProvider } from "../email/index.js";
import type { DomainEvent } from "./events.js";

export interface ActionContext {
  db: pg.Pool;
  email: EmailProvider;
  secret: string; // the automation's webhook signing secret
}

export interface Action {
  type: string;
  config: Record<string, unknown>;
}

export type ActionResult = { type: string; ok: boolean; detail?: string };

export async function runAction(action: Action, event: DomainEvent, ctx: ActionContext): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "webhook":
        return await sendWebhook(String(action.config.url ?? ""), event, ctx.secret);
      case "slack":
      case "discord":
      case "call_integration":
        return await callIntegration(ctx.db, String(action.config.integration_id ?? ""), renderText(action, event));
      case "notification":
        return await createNotification(ctx.db, action, event);
      case "email":
        return await sendEmail(ctx.email, action, event);
      default:
        return { type: action.type, ok: false, detail: "unknown action type" };
    }
  } catch (err) {
    return { type: action.type, ok: false, detail: (err as Error).message };
  }
}

async function sendWebhook(url: string, event: DomainEvent, secret: string): Promise<ActionResult> {
  if (!url) return { type: "webhook", ok: false, detail: "missing url" };
  const body = JSON.stringify({ event });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kinynx-signature": `sha256=${signature}`, "x-kinynx-event": event.type },
    body,
  });
  return { type: "webhook", ok: res.ok, detail: `status ${res.status}` };
}

async function callIntegration(db: pg.Pool, integrationId: string, text: string): Promise<ActionResult> {
  if (!integrationId) return { type: "call_integration", ok: false, detail: "missing integration_id" };
  const row = (
    await query<{ provider: string; config: { url?: string }; enabled: boolean }>(
      db,
      "SELECT provider, config, enabled FROM integrations WHERE id=$1",
      [integrationId],
    )
  )[0];
  if (!row || !row.enabled) return { type: "call_integration", ok: false, detail: "integration missing/disabled" };
  const url = row.config.url;
  if (!url) return { type: row.provider, ok: false, detail: "integration has no url" };
  // Slack & Discord both accept a JSON body with a text/content field.
  const payload = row.provider === "discord" ? { content: text } : { text };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return { type: row.provider, ok: res.ok, detail: `status ${res.status}` };
}

async function createNotification(db: pg.Pool, action: Action, event: DomainEvent): Promise<ActionResult> {
  const userId = String(action.config.user_id ?? "");
  if (!userId) return { type: "notification", ok: false, detail: "missing user_id" };
  await query(
    db,
    `INSERT INTO notifications (user_id, organization_id, type, target_type, target_id, data)
     VALUES ($1,$2,'system',$3,$4,$5)`,
    [userId, event.organizationId, String(event.data.target_type ?? event.type), event.data.target_id ?? null, JSON.stringify({ message: renderText(action, event) })],
  );
  return { type: "notification", ok: true };
}

async function sendEmail(email: EmailProvider, action: Action, event: DomainEvent): Promise<ActionResult> {
  const to = String(action.config.to ?? "");
  if (!to) return { type: "email", ok: false, detail: "missing to" };
  await email.send({ to, subject: String(action.config.subject ?? `Kinynx: ${event.type}`), html: `<p>${renderText(action, event)}</p>` });
  return { type: "email", ok: true };
}

/** Tiny {{data.x}} templating for action messages. */
function renderText(action: Action, event: DomainEvent): string {
  const tpl = String(action.config.message ?? `Event ${event.type} in workspace`);
  return tpl.replace(/\{\{\s*data\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => String(event.data[k] ?? ""));
}
