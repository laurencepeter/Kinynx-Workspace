import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kinynx:kinynx@localhost:5432/kinynx_test";
process.env.DATABASE_URL = DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars-long";

let app: FastifyInstance | undefined;
let dbAvailable = false;
try {
  await getPool(DATABASE_URL).query("SELECT 1");
  await runMigrations();
  app = await buildApp(loadConfig());
  dbAvailable = true;
} catch (err) {
  console.warn(`[templates.test] skipping: ${(err as Error).message}`);
}
after(async () => {
  if (app) await app.close();
  await closePool();
});
const skip = dbAvailable ? false : "requires Postgres";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const s = Date.now();
const uniqueName = `Roadmap Template ${s}`;

let seq = 0;
async function setup() {
  const reg = await app!.inject({ method: "POST", url: "/api/auth/register", payload: { email: `tpl${s}-${seq++}@ex.com`, password: "supersecret1" } });
  const token = reg.json().access_token as string;
  const org = (await app!.inject({ method: "POST", url: "/api/organizations", headers: auth(token), payload: { name: "T" } })).json().organization;
  const ws = (await app!.inject({ method: "POST", url: `/api/organizations/${org.id}/workspaces`, headers: auth(token), payload: { name: "W" } })).json().workspace;
  return { token, orgId: org.id, wsId: ws.id };
}

test("publish, search, download, import, and rate a template", { skip }, async () => {
  const { token, orgId, wsId } = await setup();
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${wsId}/pages`, headers: auth(token), payload: { title: "Roadmap" } })).json().page;
  await app!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(token), payload: { type: "heading", content: { text: "Q3" } } });
  const child = (await app!.inject({ method: "POST", url: `/api/workspaces/${wsId}/pages`, headers: auth(token), payload: { title: "Milestones", parent_id: page.id } })).json().page;
  assert.ok(child.id);

  const pub = await app!.inject({
    method: "POST", url: "/api/templates", headers: auth(token),
    payload: { name: uniqueName, description: "A quarterly roadmap", category: "Product Roadmap", tags: ["roadmap"], page_id: page.id },
  });
  assert.equal(pub.statusCode, 201);
  const tplId = pub.json().template.id as string;

  // Public search (no auth).
  const search = await app!.inject({ method: "GET", url: `/api/templates?q=${encodeURIComponent("Roadmap Template")}` });
  assert.ok(search.json().templates.some((t: { id: string }) => t.id === tplId));

  // Download JSON package (no auth).
  const dl = await app!.inject({ method: "GET", url: `/api/templates/${tplId}/download` });
  assert.equal(dl.json().content.page.title, "Roadmap");

  // Download .template.zip (binary, no auth) — ZIP magic bytes "PK".
  const zip = await app!.inject({ method: "GET", url: `/api/templates/${tplId}/download.zip` });
  assert.equal(zip.statusCode, 200);
  assert.equal(zip.rawPayload.subarray(0, 2).toString("latin1"), "PK");

  // Import into a fresh workspace.
  const ws2 = (await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/workspaces`, headers: auth(token), payload: { name: "W2" } })).json().workspace;
  const imp = await app!.inject({ method: "POST", url: `/api/templates/${tplId}/import`, headers: auth(token), payload: { workspace_id: ws2.id } });
  assert.equal(imp.statusCode, 201);
  const imported = await app!.inject({ method: "GET", url: `/api/pages/${imp.json().page_id}`, headers: auth(token) });
  assert.equal(imported.json().page.title, "Roadmap");
  assert.ok(imported.json().blocks.some((b: { content: { text?: string } }) => b.content.text === "Q3"));

  // Rate it; the aggregate reflects the rating.
  await app!.inject({ method: "POST", url: `/api/templates/${tplId}/rate`, headers: auth(token), payload: { rating: 5 } });
  const meta = await app!.inject({ method: "GET", url: `/api/templates/${tplId}` });
  assert.equal(Number(meta.json().template.rating), 5);
  assert.ok(Number(meta.json().template.downloads) >= 2); // download + zip + import
});

test("import an uploaded .template.zip round-trips", { skip }, async () => {
  const { token, orgId, wsId } = await setup();
  const page = (await app!.inject({ method: "POST", url: `/api/workspaces/${wsId}/pages`, headers: auth(token), payload: { title: "ZipSource" } })).json().page;
  await app!.inject({ method: "POST", url: `/api/pages/${page.id}/blocks`, headers: auth(token), payload: { type: "paragraph", content: { text: "zip body" } } });
  const tplId = (await app!.inject({ method: "POST", url: "/api/templates", headers: auth(token), payload: { name: `Zip ${s}`, category: "Other", page_id: page.id } })).json().template.id;

  const zip = await app!.inject({ method: "GET", url: `/api/templates/${tplId}/download.zip` });
  const ws2 = (await app!.inject({ method: "POST", url: `/api/organizations/${orgId}/workspaces`, headers: auth(token), payload: { name: "ZW" } })).json().workspace;

  const imp = await app!.inject({
    method: "POST", url: `/api/workspaces/${ws2.id}/templates/import-zip`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: zip.rawPayload,
  });
  assert.equal(imp.statusCode, 201);
  const imported = await app!.inject({ method: "GET", url: `/api/pages/${imp.json().page_id}`, headers: auth(token) });
  assert.equal(imported.json().page.title, "ZipSource");
});
