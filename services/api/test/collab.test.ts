import assert from "node:assert/strict";
import { after, test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

let app: FastifyInstance | undefined;
let port = 0;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as AddressInfo).port;
  dbAvailable = true;
} catch (err) {
  console.warn(`[collab.test] Postgres unavailable; skipping. (${(err as Error).message})`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";

async function register(email: string) {
  const res = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "supersecret1" } });
  return { token: res.json().access_token as string, userId: res.json().user.id as string };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const stamp = Date.now();

test("invitation via shareable link grants access", { skip }, async () => {
  const owner = await register(`owner${stamp}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "Acme" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "Eng" } })).json().workspace;

  const invite = await app!.inject({
    method: "POST",
    url: `/api/organizations/${org.id}/invitations`,
    headers: auth(owner.token),
    payload: { workspace_id: ws.id, role: "editor", max_uses: 5 },
  });
  assert.equal(invite.statusCode, 201);
  const token = invite.json().link.split("/invite/")[1];

  const invitee = await register(`invitee${stamp}@ex.com`);
  // Before accepting: no access.
  const before = await app!.inject({ method: "GET", url: `/api/workspaces/${ws.id}`, headers: auth(invitee.token) });
  assert.equal(before.statusCode, 403);

  const accept = await app!.inject({ method: "POST", url: "/api/invitations/accept", headers: auth(invitee.token), payload: { token } });
  assert.equal(accept.statusCode, 200);
  const afterAccept = await app!.inject({ method: "GET", url: `/api/workspaces/${ws.id}`, headers: auth(invitee.token) });
  assert.equal(afterAccept.statusCode, 200);
});

test("group grant gives a whole team workspace access", { skip }, async () => {
  const owner = await register(`gowner${stamp}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "Beta" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "Design" } })).json().workspace;

  const member = await register(`gmember${stamp}@ex.com`);
  // Add member to org (viewer) so they exist in the org, then group grants editor on the workspace.
  await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/members`, headers: auth(owner.token), payload: { user_id: member.userId, role: "viewer" } });

  const group = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/groups`, headers: auth(owner.token), payload: { name: "Designers", color: "#22d3ee" } })).json().group;
  await app!.inject({ method: "POST", url: `/api/groups/${group.id}/members`, headers: auth(owner.token), payload: { user_id: member.userId } });
  await app!.inject({ method: "POST", url: `/api/groups/${group.id}/grants`, headers: auth(owner.token), payload: { scope_type: "workspace", scope_id: ws.id, role: "editor" } });

  // Member can now create a page (editor via group grant), which a bare viewer could not.
  const page = await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(member.token), payload: { title: "Via group" } });
  assert.equal(page.statusCode, 201);
});

test("database report computes status counts (with colors) and progress rollup", { skip }, async () => {
  const owner = await register(`db${stamp}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "PM" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "Projects" } })).json().workspace;
  const db = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/databases`, headers: auth(owner.token), payload: { name: "Tasks" } })).json().database;

  const status = (await app!.inject({
    method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(owner.token),
    payload: { name: "Status", type: "select", config: { options: [{ name: "Todo", color: "#f87171" }, { name: "Done", color: "#34d399" }] } },
  })).json().property;
  const progress = (await app!.inject({
    method: "POST", url: `/api/databases/${db.id}/properties`, headers: auth(owner.token),
    payload: { name: "Progress", type: "number", config: {} },
  })).json().property;

  for (const [s, p] of [["Todo", 20], ["Done", 100], ["Done", 80]] as const) {
    await app!.inject({ method: "POST", url: `/api/databases/${db.id}/records`, headers: auth(owner.token), payload: { values: { [status.id]: s, [progress.id]: p } } });
  }

  const report = await app!.inject({ method: "GET", url: `/api/databases/${db.id}/report?group_by=${status.id}&progress=${progress.id}`, headers: auth(owner.token) });
  const body = report.json();
  assert.equal(body.total, 3);
  const done = body.by_status.find((s: { name: string }) => s.name === "Done");
  assert.equal(done.count, 2);
  assert.equal(done.color, "#34d399");
  assert.equal(body.progress.avg, +((20 + 100 + 80) / 3).toFixed(2));
});

test("page versioning: snapshot, modify, restore", { skip }, async () => {
  const owner = await register(`ver${stamp}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "Docs" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "Wiki" } })).json().workspace;
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(owner.token), payload: { title: "Original" } })).json().page;
  await app!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(owner.token), payload: { type: "paragraph", content: { text: "v1 content" } } });

  const v = await app!.inject({ method: "POST", url: `/api/pages/${page.id}/versions`, headers: auth(owner.token) });
  assert.equal(v.json().version, 1);

  // Change the page.
  await app!.inject({ method: "PATCH", url: `/api/pages/${page.id}`, headers: auth(owner.token), payload: { title: "Changed" } });

  // Restore v1.
  const restore = await app!.inject({ method: "POST", url: `/api/pages/${page.id}/versions/1/restore`, headers: auth(owner.token) });
  assert.equal(restore.statusCode, 200);
  const after = await app!.inject({ method: "GET", url: `/api/pages/${page.id}`, headers: auth(owner.token) });
  assert.equal(after.json().page.title, "Original");
  assert.ok(after.json().blocks.some((b: { content: { text?: string } }) => b.content.text === "v1 content"));
});

test("export a page and import it back", { skip }, async () => {
  const owner = await register(`exp${stamp}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "Exp" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "W" } })).json().workspace;
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(owner.token), payload: { title: "Template Root" } })).json().page;
  await app!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(owner.token), payload: { type: "heading", content: { text: "Hello" } } });

  const exported = await app!.inject({ method: "GET", url: `/api/pages/${page.id}/export`, headers: auth(owner.token) });
  assert.equal(exported.json().page.title, "Template Root");

  const imported = await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/import`, headers: auth(owner.token), payload: { page: exported.json().page } });
  assert.equal(imported.statusCode, 201);
  const newPage = await app!.inject({ method: "GET", url: `/api/pages/${imported.json().page_id}`, headers: auth(owner.token) });
  assert.equal(newPage.json().page.title, "Template Root");
  assert.ok(newPage.json().blocks.some((b: { content: { text?: string } }) => b.content.text === "Hello"));
});

test("realtime: presence + live block broadcast over WebSocket", { skip }, async () => {
  const owner = await register(`rt${stamp}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "RT" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "Live" } })).json().workspace;
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(owner.token), payload: { title: "Live Page" } })).json().page;

  const url = `ws://127.0.0.1:${port}/api/realtime?workspaceId=${ws.id}&token=${owner.token}`;
  const client = new WebSocket(url);
  await once(client, "open");

  const events: Array<{ type: string; [k: string]: unknown }> = [];
  client.on("message", (raw) => events.push(JSON.parse(raw.toString())));

  // Trigger a live block creation via REST — the WS client should receive it.
  const gotBlock = new Promise<void>((resolve) => {
    client.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "block.created") resolve();
    });
  });
  await app!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(owner.token), payload: { type: "paragraph", content: { text: "live" } } });
  await gotBlock;

  // First message should have been a presence snapshot including the owner.
  const presence = events.find((e) => e.type === "presence") as { users: Array<{ email: string }> } | undefined;
  assert.ok(presence && presence.users.some((u) => u.email === `rt${stamp}@ex.com`));

  client.close();
});
