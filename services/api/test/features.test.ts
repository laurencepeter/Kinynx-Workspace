import assert from "node:assert/strict";
import { after, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR = join(tmpdir(), `kinynx-uploads-${Date.now()}`);

let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  dbAvailable = true;
} catch (err) {
  console.warn(`[features.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();

async function register(email: string) {
  const r = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "supersecret1" } });
  return { token: r.json().access_token as string, userId: r.json().user.id as string };
}

test("comment @mention creates a notification for the mentioned member", { skip }, async () => {
  const owner = await register(`fowner${s}@ex.com`);
  const mentionee = await register(`fmention${s}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "F" } })).json().organization;
  await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/members`, headers: auth(owner.token), payload: { user_id: mentionee.userId, role: "editor" } });
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "W" } })).json().workspace;
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(owner.token), payload: { title: "P" } })).json().page;

  const c = await app!.inject({
    method: "POST", url: "/api/comments", headers: auth(owner.token),
    payload: { target_type: "page", target_id: page.id, body: "hey take a look", mentions: [mentionee.userId] },
  });
  assert.equal(c.statusCode, 201);

  const list = await app!.inject({ method: "GET", url: `/api/comments?target_type=page&target_id=${page.id}`, headers: auth(owner.token) });
  assert.equal(list.json().comments.length, 1);

  const count = await app!.inject({ method: "GET", url: "/api/notifications/unread-count", headers: auth(mentionee.token) });
  assert.equal(count.json().unread, 1);
  const notifs = await app!.inject({ method: "GET", url: "/api/notifications?unread=1", headers: auth(mentionee.token) });
  assert.equal(notifs.json().notifications[0].type, "mention");

  const readAll = await app!.inject({ method: "POST", url: "/api/notifications/read-all", headers: auth(mentionee.token) });
  assert.equal(readAll.statusCode, 200);
  const count2 = await app!.inject({ method: "GET", url: "/api/notifications/unread-count", headers: auth(mentionee.token) });
  assert.equal(count2.json().unread, 0);
});

test("publishing: password-protected public page", { skip }, async () => {
  const owner = await register(`fpub${s}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "Pub" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "W" } })).json().workspace;
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${ws.id}/pages`, headers: auth(owner.token), payload: { title: "Public Doc" } })).json().page;
  await app!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(owner.token), payload: { type: "paragraph", content: { text: "visible" } } });

  const pub = await app!.inject({ method: "POST", url: `/api/pages/${page.id}/publish`, headers: auth(owner.token), payload: { password: "secret1", seo: { title: "Public Doc" } } });
  assert.equal(pub.statusCode, 201);
  const slug = pub.json().slug as string;
  assert.equal(pub.json().password_protected, true);

  const noPw = await app!.inject({ method: "GET", url: `/api/public/${slug}` });
  assert.equal(noPw.statusCode, 401);

  const withPw = await app!.inject({ method: "GET", url: `/api/public/${slug}?password=secret1` });
  assert.equal(withPw.statusCode, 200);
  assert.equal(withPw.json().page.title, "Public Doc");
  assert.ok(withPw.json().blocks.some((b: { content: { text?: string } }) => b.content.text === "visible"));
});

test("file upload round-trip (local storage driver)", { skip }, async () => {
  const owner = await register(`ffile${s}@ex.com`);
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(owner.token), payload: { name: "Files" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(owner.token), payload: { name: "W" } })).json().workspace;

  const bytes = Buffer.from("hello kinynx file storage", "utf8");
  const meta = await app!.inject({
    method: "POST", url: `/api/workspaces/${ws.id}/files`, headers: auth(owner.token),
    payload: { filename: "note.txt", content_type: "text/plain", size_bytes: bytes.length },
  });
  assert.equal(meta.statusCode, 201);
  const fileId = meta.json().file.id as string;

  const up = await app!.inject({
    method: "PUT", url: `/api/files/${fileId}/content`,
    headers: { ...auth(owner.token), "content-type": "application/octet-stream" },
    payload: bytes,
  });
  assert.equal(up.statusCode, 200);
  assert.equal(up.json().size_bytes, bytes.length);

  const down = await app!.inject({ method: "GET", url: `/api/files/${fileId}/content`, headers: auth(owner.token) });
  assert.equal(down.statusCode, 200);
  assert.equal(down.body, bytes.toString("utf8"));
});

test("OpenAPI document is served and valid-ish", { skip }, async () => {
  const res = await app!.inject({ method: "GET", url: "/api/openapi.json" });
  assert.equal(res.statusCode, 200);
  const doc = res.json();
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/api/pages/{id}"]);
  assert.ok(doc.components.securitySchemes.bearerAuth);
});
