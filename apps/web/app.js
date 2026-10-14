// Vanilla-JS reference client for Kinynx. No build step: talks to the API
// through the reverse proxy at /api. Every permission check happens server-side;
// hiding a control here is UX only.
// SECURITY: user-supplied text is rendered via textContent/DOM APIs only.
const R = window.KinynxRender;
const $ = (id) => document.getElementById(id);
const state = {
  token: null, refresh: null, me: null, info: null,
  orgs: [], orgId: null, workspaces: [], wsId: null, pages: [], pageId: null,
  page: null, blocks: [], pendingRefresh: false,
  showAuthors: (() => { try { return localStorage.getItem("kinynx_authors") !== "0"; } catch { return true; } })(),
};

// ── Small DOM helpers ────────────────────────────────────────────────────────
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2400);
}

const short = (email) => (email || "someone").split("@")[0];
const ago = (iso) => {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileSafe = (s) => (s || "page").replace(/[^\w.-]+/g, "-").slice(0, 80);

// ── API (with transparent access-token refresh) ──────────────────────────────
async function refreshSession() {
  const refresh = state.refresh || localStorage.getItem("kinynx_refresh");
  if (!refresh) throw new Error("no session");
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) { localStorage.removeItem("kinynx_refresh"); throw new Error("session expired"); }
  const data = await res.json();
  state.token = data.access_token;
  state.refresh = data.refresh_token;
  localStorage.setItem("kinynx_refresh", data.refresh_token);
}

async function api(path, { method = "GET", body, raw, quiet, retry = true } = {}) {
  const headers = state.token ? { authorization: `Bearer ${state.token}` } : {};
  if (body !== undefined && !raw) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "application/octet-stream";
  const res = await fetch(`/api${path}`, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  if (res.status === 401 && retry && state.refresh && !path.startsWith("/auth/")) {
    await refreshSession();
    return api(path, { method, body, raw, quiet, retry: false });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 402 ? `${data.error || "Not in your plan"} — see ✦ Plan` : data.error || `Error ${res.status}`;
    if (!quiet) toast(msg);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Dialogs (native <dialog>) ────────────────────────────────────────────────
function dialog(title, content, actions) {
  const dlg = $("dlg");
  return new Promise((resolve) => {
    const footer = h("div", { class: "row", style: "justify-content:flex-end;margin-top:16px" });
    for (const a of actions) {
      footer.append(h("button", {
        type: a.submit ? "submit" : "button",
        class: a.class || (a.submit ? "" : "ghost"),
        onclick: a.submit ? null : () => { dlg.close(); resolve(a.value); },
      }, a.label));
    }
    const form = h("form", { method: "dialog", onsubmit: (e) => { e.preventDefault(); const v = actions.find((a) => a.submit)?.value; dlg.close(); resolve(typeof v === "function" ? v() : v); } },
      h("h3", {}, title), content, footer);
    dlg.replaceChildren(form);
    dlg.onclose = () => resolve(undefined);
    dlg.showModal();
    form.querySelector("input,textarea,select")?.focus();
  });
}

async function promptText(title, label, value = "", { placeholder = "", maxlength = 400 } = {}) {
  const input = h("input", { value, placeholder, maxlength: String(maxlength), "aria-label": label });
  const v = await dialog(title, h("div", { class: "stack" }, h("p", { class: "small muted", style: "margin:0" }, label), input), [
    { label: "Cancel", value: undefined },
    { label: "Save", submit: true, value: () => input.value.trim() },
  ]);
  return v || null;
}

// Destructive actions require typing the resource name (server checks it too).
async function confirmDelete(kind, name, extra = "") {
  const input = h("input", { placeholder: name, "aria-label": `Type ${name} to confirm` });
  const v = await dialog(`Delete ${kind}?`, h("div", { class: "stack" },
    h("p", { style: "margin:0" }, `This permanently deletes “${name}”${extra}. Type the name to confirm.`), input), [
    { label: "Cancel", value: undefined },
    { label: `Delete ${kind}`, submit: true, class: "danger", value: () => input.value },
  ]);
  if (v === undefined) return null;
  if (v !== name) { toast("Name didn't match — nothing deleted"); return null; }
  return v;
}

function popupMenu(anchor, items) {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const menu = h("div", { class: "menu", role: "menu", style: `top:${r.bottom + window.scrollY + 4}px;left:${Math.min(r.left + window.scrollX, window.innerWidth - 210)}px` },
    items.map((it) => h("button", { role: "menuitem", onclick: () => { menu.remove(); it.run(); } }, it.label)));
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
  menu.querySelector("button")?.focus();
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function authenticate(path) {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || password.length < 8) { toast("Enter an email and a password of 8+ characters"); return; }
  const data = await api(path, { method: "POST", body: { email, password } });
  state.token = data.access_token;
  state.refresh = data.refresh_token;
  localStorage.setItem("kinynx_refresh", data.refresh_token);
  await boot();
  await acceptPendingInvite();
}
$("authForm").onsubmit = (e) => { e.preventDefault(); authenticate("/auth/login").catch(() => {}); };
$("registerBtn").onclick = () => authenticate("/auth/register").catch(() => {});
$("forgotBtn").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) { toast("Enter your email first"); return; }
  await api("/auth/password/forgot", { method: "POST", body: { email } }).catch(() => {});
  toast("If that account exists, a reset link is on its way");
};
$("logout").onclick = async () => {
  if (state.refresh) await api("/auth/logout", { method: "POST", body: { refresh_token: state.refresh }, quiet: true }).catch(() => {});
  localStorage.removeItem("kinynx_refresh");
  location.reload();
};

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  for (const id of ["planBtn", "bell", "logout"]) $(id).classList.remove("hidden");
  state.me = await api("/auth/me");
  $("whoami").textContent = state.me.email;
  state.info = await api("/system/info");
  $("planLabel").textContent = state.info.edition === "Community" ? "Pro" : state.info.edition;
  await loadOrgs();
  await refreshNotifCount();
  if (!state.notifTimer) state.notifTimer = setInterval(refreshNotifCount, 30000);
}

// ── Plan & features (moved out of the page into a header modal) ──────────────
$("planBtn").onclick = async () => {
  const info = state.info;
  const label = (k) => k.replace(/_/g, " ");
  const feats = Object.entries(info.features).sort((a, b) => Number(b[1]) - Number(a[1]));
  const fmt = (k, v) => (v == null || v < 0 ? "Unlimited" : k.endsWith("bytes") ? `${Math.round(v / 1048576)} MB` : v);
  const limits = Object.entries(info.limits || {}).map(([k, v]) => h("span", { class: "chip" }, `${label(k.replace(/_bytes$/, ""))}: ${fmt(k, v)}`));
  const body = h("div", { class: "stack" },
    h("p", { style: "margin:0" }, "Current edition: ", h("b", {}, info.edition), info.plan ? ` (${info.plan})` : ""),
    h("div", { class: "plan-grid" }, feats.map(([k, on]) => h("span", { class: `chip ${on ? "on" : "off"}` }, `${on ? "✓" : "○"} ${label(k)}`))),
    limits.length ? h("div", { class: "row", style: "flex-wrap:wrap" }, limits) : null,
    h("p", { class: "small muted", style: "margin:0" }, "Community is the full Apache-2.0 core. Enterprise features unlock with a signed license (Admin → License)."),
  );
  const choice = await dialog("Plan & features", body, [
    { label: "Close", value: undefined },
    ...(info.edition === "Community" && state.orgId ? [{ label: "Upgrade", value: "upgrade" }] : []),
  ]);
  if (choice === "upgrade") {
    const res = await api(`/organizations/${state.orgId}/billing/checkout`, { method: "POST", body: { plan: "team" } }).catch(() => null);
    if (!res) return;
    const url = res.url && R.safeUrl(res.url);
    if (url && url.startsWith("https:")) location.href = url;
    else dialog("Upgrade", h("p", {}, res.instructions || res.message || "Contact your administrator to upgrade."), [{ label: "OK", value: true }]);
  }
};

// ── Organizations ────────────────────────────────────────────────────────────
async function loadOrgs() {
  ({ organizations: state.orgs } = await api("/organizations"));
  if (!state.orgs.some((o) => o.id === state.orgId)) state.orgId = state.orgs[0]?.id ?? null;
  const sel = $("orgSelect");
  sel.replaceChildren(...state.orgs.map((o) => h("option", { value: o.id, selected: o.id === state.orgId }, `${o.name} · ${o.role}`)));
  if (!state.orgs.length) sel.append(h("option", { value: "" }, "No organizations yet — click ＋"));
  await loadWorkspaces();
}
const currentOrg = () => state.orgs.find((o) => o.id === state.orgId);
$("orgSelect").onchange = (e) => { state.orgId = e.target.value; state.wsId = null; closePage(); loadWorkspaces(); };
$("orgNew").onclick = async () => {
  const name = await promptText("New organization", "Name", "", { maxlength: 120 });
  if (!name) return;
  const { organization } = await api("/organizations", { method: "POST", body: { name } });
  state.orgId = organization.id; state.wsId = null; closePage();
  toast("Organization created"); loadOrgs();
};
$("orgRename").onclick = async () => {
  const org = currentOrg(); if (!org) return;
  const name = await promptText("Rename organization", "Name", org.name, { maxlength: 120 });
  if (!name || name === org.name) return;
  await api(`/organizations/${org.id}`, { method: "PATCH", body: { name } });
  toast("Renamed"); loadOrgs();
};
$("orgDelete").onclick = async () => {
  const org = currentOrg(); if (!org) return;
  const confirm = await confirmDelete("organization", org.name, " with all its workspaces and pages");
  if (confirm == null) return;
  await api(`/organizations/${org.id}`, { method: "DELETE", body: { confirm } });
  state.orgId = null; state.wsId = null; closePage();
  toast("Organization deleted"); loadOrgs();
};

// ── Workspaces ───────────────────────────────────────────────────────────────
async function loadWorkspaces() {
  const list = $("workspaces");
  if (!state.orgId) { list.replaceChildren(); state.workspaces = []; renderPages(); return; }
  ({ workspaces: state.workspaces } = await api(`/organizations/${state.orgId}/workspaces`));
  if (!state.workspaces.some((w) => w.id === state.wsId)) state.wsId = state.workspaces[0]?.id ?? null;
  list.replaceChildren(...state.workspaces.map((w) => sidebarItem({
    icon: w.icon || "🗂️", label: w.name, active: w.id === state.wsId,
    onopen: () => { state.wsId = w.id; closePage(); loadWorkspaces(); },
    actions: [
      ["✎", "Rename", async () => {
        const name = await promptText("Rename workspace", "Name", w.name, { maxlength: 120 });
        if (!name || name === w.name) return;
        await api(`/workspaces/${w.id}`, { method: "PATCH", body: { name } });
        toast("Renamed"); loadWorkspaces();
      }],
      ["🗑", "Delete", async () => {
        const confirm = await confirmDelete("workspace", w.name, " and every page in it");
        if (confirm == null) return;
        await api(`/workspaces/${w.id}`, { method: "DELETE", body: { confirm } });
        if (state.wsId === w.id) { state.wsId = null; closePage(); }
        toast("Workspace deleted"); loadWorkspaces();
      }],
    ],
  })));
  if (!state.workspaces.length) list.append(h("p", { class: "small muted", style: "margin:4px 0" }, "No workspaces yet."));
  ensureRealtime();
  await loadPages();
}
$("wsNew").onclick = async () => {
  if (!state.orgId) { toast("Create an organization first"); return; }
  const name = await promptText("New workspace", "Name", "", { maxlength: 120 });
  if (!name) return;
  const { workspace } = await api(`/organizations/${state.orgId}/workspaces`, { method: "POST", body: { name } });
  state.wsId = workspace.id; closePage();
  toast("Workspace created"); loadWorkspaces();
};
$("invite").onclick = async () => {
  if (!state.orgId) return;
  const data = await api(`/organizations/${state.orgId}/invitations`, {
    method: "POST", body: { workspace_id: state.wsId ?? undefined, role: "editor", max_uses: 25 },
  });
  // Build the link from this browser's origin so it is correct even if the
  // server's PUBLIC_APP_URL is unset (emailed links still need PUBLIC_APP_URL).
  const link = `${location.origin}${new URL(data.link).pathname}`;
  try { await navigator.clipboard.writeText(link); toast("Editor invite link copied"); }
  catch { dialog("Invite link", h("input", { value: link, readOnly: true }), [{ label: "Done", value: true }]); }
};

function sidebarItem({ icon, label, active, depth = 0, onopen, actions }) {
  const el = h("div", { class: "item" + (active ? " active" : ""), tabindex: "0", style: depth ? `padding-left:${8 + depth * 16}px` : "",
    onclick: onopen, onkeydown: (e) => { if (e.key === "Enter" && e.target === el) onopen(); } },
    h("span", {}, icon), h("span", { class: "label", title: label }, label),
    h("span", { class: "actions" }, actions.map(([glyph, title, run]) =>
      h("button", { class: "icon", title, "aria-label": title, onclick: (e) => { e.stopPropagation(); run(e); } }, glyph))));
  return el;
}

// ── Pages ────────────────────────────────────────────────────────────────────
async function loadPages() {
  state.pages = state.wsId ? (await api(`/workspaces/${state.wsId}/pages`)).pages : [];
  renderPages();
}

function renderPages() {
  const list = $("pages");
  const byParent = {};
  state.pages.forEach((p) => { (byParent[p.parent_id || "root"] ||= []).push(p); });
  const out = [];
  const walk = (parent, depth) => (byParent[parent] || []).forEach((p) => {
    out.push(sidebarItem({
      icon: p.icon || "📄", label: p.title || "Untitled", depth, active: p.id === state.pageId,
      onopen: () => openPage(p.id),
      actions: [
        ["＋", "Add sub-page", () => createPage(p.id)],
        ["⋯", "More", (e) => popupMenu(e.currentTarget, [
          { label: "✎ Rename", run: async () => {
            const title = await promptText("Rename page", "Title", p.title);
            if (!title) return;
            await api(`/pages/${p.id}`, { method: "PATCH", body: { title } });
            if (state.pageId === p.id) $("pageTitle").value = title;
            loadPages();
          } },
          { label: "⧉ Duplicate", run: () => duplicatePage(p.id) },
          { label: "🗑 Move to trash", run: () => deletePage(p) },
        ])],
      ],
    }));
    walk(p.id, depth + 1);
  });
  walk("root", 0);
  list.replaceChildren(...out);
  if (state.wsId && !out.length) list.append(h("p", { class: "small muted", style: "margin:4px 0" }, "No pages yet — click ＋ or import a template."));
}

async function createPage(parentId) {
  if (!state.wsId) { toast("Create a workspace first"); return; }
  const title = await promptText(parentId ? "New sub-page" : "New page", "Title", "", { placeholder: "Untitled" });
  if (title === null) return;
  const { page } = await api(`/workspaces/${state.wsId}/pages`, { method: "POST", body: { title: title || "Untitled", parent_id: parentId ?? undefined } });
  await loadPages();
  openPage(page.id);
}
$("pageNew").onclick = () => createPage(null);

async function deletePage(p) {
  const ok = await dialog("Move page to trash?", h("p", {}, `“${p.title}” and its sub-pages will be archived.`), [
    { label: "Cancel", value: false }, { label: "Move to trash", class: "danger", value: true },
  ]);
  if (!ok) return;
  await api(`/pages/${p.id}`, { method: "DELETE" });
  if (state.pageId === p.id) closePage();
  toast("Page archived"); loadPages();
}

async function duplicatePage(id) {
  const { page } = await api(`/pages/${id}/export`);
  page.title = `${page.title} (copy)`;
  const res = await api(`/workspaces/${state.wsId}/import`, { method: "POST", body: { page } });
  await loadPages(); openPage(res.page_id); toast("Duplicated");
}

function closePage() {
  state.pageId = null; state.page = null; state.blocks = [];
  $("editor").classList.add("hidden");
  $("noPage").classList.remove("hidden");
  $("commentsCard").classList.add("hidden");
}

async function openPage(id, { keepFocus } = {}) {
  const switching = state.pageId !== id;
  state.pageId = id;
  if (switching) sendPresence(id, false);
  const { page, blocks } = await api(`/pages/${id}`);
  if (state.pageId !== id) return; // user navigated away mid-request
  state.page = page; state.blocks = blocks;
  $("noPage").classList.add("hidden");
  $("editor").classList.remove("hidden");
  $("pageIcon").textContent = page.icon || "📄";
  if (document.activeElement !== $("pageTitle")) $("pageTitle").value = page.title;
  renderMeta();
  renderBlocks(keepFocus);
  if (switching) { renderPages(); loadComments(); }
}

function renderMeta() {
  const p = state.page;
  const parts = [`${state.blocks.length} block${state.blocks.length === 1 ? "" : "s"}`];
  if (p.created_by_email) parts.push(`created by ${short(p.created_by_email)}`);
  if (p.updated_at) parts.push(`updated ${ago(p.updated_at)}`);
  $("pageMeta").textContent = parts.join(" · ");
  // Contributor legend — each person keeps the same colour everywhere.
  const people = new Map();
  for (const b of state.blocks) for (const e of [b.created_by_email, b.updated_by_email]) if (e) people.set(e, (people.get(e) || 0) + 1);
  $("contributors").replaceChildren(...[...people.keys()].map((e) =>
    h("span", { class: "chip", title: e }, h("span", { class: "dot", style: `background:${R.colorFor(e)}` }), short(e))));
}

$("pageTitle").addEventListener("change", async () => {
  if (!state.pageId) return;
  await api(`/pages/${state.pageId}`, { method: "PATCH", body: { title: $("pageTitle").value.trim() || "Untitled" } });
  toast("Saved"); loadPages();
});
$("pageIcon").onclick = async () => {
  const icon = await promptText("Page icon", "Paste an emoji", state.page?.icon || "", { maxlength: 8 });
  if (!icon) return;
  await api(`/pages/${state.pageId}`, { method: "PATCH", body: { icon } });
  $("pageIcon").textContent = icon; loadPages();
};
$("authorsBtn").onclick = () => {
  state.showAuthors = !state.showAuthors;
  try { localStorage.setItem("kinynx_authors", state.showAuthors ? "1" : "0"); } catch {}
  applyAuthorsToggle();
};
function applyAuthorsToggle() {
  $("blocks").classList.toggle("show-authors", state.showAuthors);
  $("contributors").classList.toggle("hidden", !state.showAuthors);
  $("authorsBtn").setAttribute("aria-pressed", String(state.showAuthors));
}

// ── Block ordering: fractional string keys (lexical order) ───────────────────
const DIG = "0123456789abcdefghijklmnopqrstuvwxyz";
function keyBetween(a, b) {
  // Returns a key strictly between a ("" = start) and b (null = end).
  // Keys never end in "0", so there is always room below any key.
  let out = "";
  for (let i = 0; ; i++) {
    const ca = i < a.length ? DIG.indexOf(a[i]) : 0;
    const cb = b != null ? (i < b.length ? DIG.indexOf(b[i]) : 0) : DIG.length;
    if (ca === cb) { out += DIG[ca]; continue; }
    const m = Math.floor((ca + cb) / 2);
    if (m > ca) return out + DIG[m];
    out += DIG[ca]; b = null; // adjacent digits: keep a's digit, anything larger after it works
  }
}
// Legacy blocks share the default position "n"; give them distinct keys once.
async function normalizePositions() {
  const seen = new Set();
  if (state.blocks.every((b) => !seen.has(b.position) && seen.add(b.position))) return;
  let prev = "";
  for (const b of state.blocks) {
    const pos = keyBetween(prev, null);
    prev = pos;
    if (b.position !== pos) {
      b.position = pos;
      await api(`/blocks/${b.id}`, { method: "PATCH", body: { position: pos }, quiet: true }).catch(() => {});
    }
  }
}

// ── Blocks: inline, editable rendering ───────────────────────────────────────
const TEXT_TYPES = new Set(["paragraph", "heading", "checklist", "quote", "code"]);
const PLACEHOLDER = { paragraph: "Type something…", heading: "Heading", checklist: "To-do", quote: "Quote", code: "Code" };

function renderBlocks(keepFocus) {
  const wrap = $("blocks");
  const focusedId = keepFocus ? document.activeElement?.closest?.(".blk")?.dataset.id : null;
  wrap.replaceChildren(...state.blocks.map(blockEl));
  if (!state.blocks.length) wrap.append(h("p", { class: "muted small", style: "margin:6px 10px" }, "Empty page. Add your first block below ↓"));
  applyAuthorsToggle();
  if (focusedId) wrap.querySelector(`.blk[data-id="${CSS.escape(focusedId)}"] .ed`)?.focus();
}

function blockEl(b) {
  const author = b.created_by_email;
  const tag = author
    ? `Added by ${author}${b.updated_by_email && b.updated_by_email !== author ? ` · edited by ${b.updated_by_email}` : ""} · ${ago(b.updated_at)}`
    : "Author unknown";
  const el = h("div", { class: "blk", "data-id": b.id, style: `--author:${author ? R.colorFor(author) : "transparent"}`, title: "" });
  const tools = h("div", { class: "tools" },
    h("button", { class: "icon", title: "Block options", "aria-label": "Block options", onclick: (e) => blockMenu(e.currentTarget, b) }, "⋮⋮"));
  const body = h("div", { class: "body" }, blockBody(b));
  const who = h("span", { class: "author-tag", title: tag }, author ? h("span", { class: "dot", style: `background:${R.colorFor(author)}` }) : null, " ", author ? short(author) : "");
  el.append(tools, body, who);
  return el;
}

function editable(b, tagName, extra = {}) {
  const ed = h(tagName, { class: "ed", contentEditable: "plaintext-only", spellcheck: b.type !== "code", "data-ph": PLACEHOLDER[b.type] || "", ...extra });
  if (ed.contentEditable !== "plaintext-only") ed.contentEditable = "true"; // Firefox < 136 fallback
  ed.textContent = R.textOf(b);
  ed.addEventListener("focus", () => sendPresence(state.pageId, true));
  ed.addEventListener("blur", () => { sendPresence(state.pageId, false); saveText(b, ed.innerText.replace(/\n$/, "")); flushRefresh(); });
  ed.addEventListener("paste", (e) => { // force plain text
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  ed.addEventListener("keydown", (e) => onBlockKey(e, b, ed));
  return ed;
}

function blockBody(b) {
  const c = b.content || {};
  switch (b.type) {
    case "heading": return editable(b, `h${Math.min(3, Math.max(1, Number(c.level) || 2))}`);
    case "paragraph": return editable(b, "p");
    case "quote": return h("blockquote", {}, editable(b, "div"));
    case "code": return h("pre", {}, editable(b, "code"));
    case "checklist": {
      const box = h("input", { type: "checkbox", checked: !!c.checked, "aria-label": "Done",
        onchange: async (e) => {
          const checked = e.target.checked;
          e.target.closest(".check").classList.toggle("done", checked);
          await patchBlock(b, { content: { ...b.content, checked } });
        } });
      return h("div", { class: "check" + (c.checked ? " done" : "") }, box, editable(b, "div", { style: "flex:1" }));
    }
    case "divider": return h("hr");
    default: return R.renderBlock(b); // image, embed, file, … (read-only, URL-sanitised)
  }
}

async function patchBlock(b, patch) {
  if (b._ready) await b._ready;
  const { block } = await api(`/blocks/${b.id}`, { method: "PATCH", body: patch });
  Object.assign(b, block);
  renderMeta();
  return block;
}

async function saveText(b, text) {
  if (text === R.textOf(b)) return;
  const key = b.type === "code" && b.content?.code !== undefined ? "code" : "text";
  await patchBlock(b, { content: { ...b.content, [key]: text } }).catch(() => {});
}

// Optimistic insert: the block appears (and takes focus) immediately so typing
// isn't lost while the POST is in flight; writes to it wait on `_ready`.
async function insertBlockAfter(after, type, content = {}) {
  await normalizePositions();
  const idx = after ? state.blocks.indexOf(after) : state.blocks.length - 1;
  const prev = idx >= 0 ? state.blocks[idx].position : "";
  const next = state.blocks[idx + 1]?.position ?? null;
  const position = keyBetween(prev, next);
  const tmpId = `tmp-${Math.random().toString(36).slice(2)}`;
  const b = { id: tmpId, type, content, position, created_by_email: state.me?.email, updated_at: new Date().toISOString() };
  state.blocks.splice(idx + 1, 0, b);
  renderBlocks();
  $("blocks").querySelector(`.blk[data-id="${tmpId}"] .ed`)?.focus();
  b._ready = api(`/pages/${state.pageId}/blocks`, { method: "POST", body: { type, content, position } })
    .then(({ block }) => {
      Object.assign(b, block);
      const el = $("blocks").querySelector(`.blk[data-id="${tmpId}"]`);
      if (el) el.dataset.id = block.id;
      delete b._ready;
      renderMeta();
    })
    .catch((err) => { state.blocks.splice(state.blocks.indexOf(b), 1); renderBlocks(); throw err; });
  await b._ready;
  return b;
}

async function removeBlock(b, focusPrev) {
  if (b._ready) await b._ready;
  await api(`/blocks/${b.id}`, { method: "DELETE" });
  const idx = state.blocks.indexOf(b);
  state.blocks.splice(idx, 1);
  renderBlocks(); renderMeta();
  if (focusPrev && idx > 0) {
    const ed = $("blocks").querySelector(`.blk[data-id="${CSS.escape(state.blocks[idx - 1].id)}"] .ed`);
    if (ed) { ed.focus(); placeCaretAtEnd(ed); }
  }
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el); range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
}

function onBlockKey(e, b, ed) {
  if (e.key === "Enter" && !e.shiftKey && b.type !== "code") {
    e.preventDefault();
    saveText(b, ed.innerText.replace(/\n$/, ""));
    // Lists continue as lists; everything else continues as text.
    insertBlockAfter(b, b.type === "checklist" ? "checklist" : "paragraph", b.type === "checklist" ? { text: "", checked: false } : { text: "" });
  } else if (e.key === "Backspace" && ed.innerText.trim() === "" && b.type !== "code") {
    e.preventDefault();
    removeBlock(b, true);
  }
}

async function moveBlock(b, dir) {
  await normalizePositions();
  const i = state.blocks.indexOf(b);
  const j = i + dir;
  if (j < 0 || j >= state.blocks.length) return;
  const [lo, hi] = dir < 0 ? [state.blocks[j - 1]?.position ?? "", state.blocks[j].position] : [state.blocks[j].position, state.blocks[j + 1]?.position ?? null];
  await patchBlock(b, { position: keyBetween(lo, hi) });
  state.blocks.splice(i, 1); state.blocks.splice(j, 0, b);
  renderBlocks();
}

function blockMenu(anchor, b) {
  const turnInto = (type, extra = {}) => ({ label: `Turn into ${type}`, run: () => patchBlock(b, { type, content: { text: R.textOf(b), ...extra } }).then(() => renderBlocks()) });
  const items = [
    { label: "↑ Move up", run: () => moveBlock(b, -1) },
    { label: "↓ Move down", run: () => moveBlock(b, 1) },
    { label: "＋ Insert text below", run: () => insertBlockAfter(b, "paragraph", { text: "" }) },
    { label: "― Insert divider below", run: () => insertBlockAfter(b, "divider") },
  ];
  if (TEXT_TYPES.has(b.type)) {
    for (const t of ["paragraph", "heading", "checklist", "quote", "code"]) if (t !== b.type) items.push(turnInto(t, t === "checklist" ? { checked: false } : t === "heading" ? { level: 2 } : {}));
  }
  if (b.type === "heading") for (const lv of [1, 2, 3]) items.push({ label: `Heading level ${lv}`, run: () => patchBlock(b, { content: { ...b.content, level: lv } }).then(() => renderBlocks()) });
  items.push({ label: "💬 Comment on block", run: () => commentOnBlock(b) });
  items.push({ label: "🗑 Delete block", run: () => removeBlock(b) });
  popupMenu(anchor, items);
}

// Composer: pick a type or use a slash shortcut, Enter adds the block.
const SLASH = { "/h": "heading", "/h1": "heading", "/todo": "checklist", "/check": "checklist", "/quote": "quote", "/code": "code", "/hr": "divider", "/divider": "divider", "/img": "image", "/link": "embed" };
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  if (!state.pageId) return;
  let type = $("blockType").value;
  let text = $("blockText").value;
  const m = text.match(/^(\/\w+)\s*(.*)$/s);
  if (m && SLASH[m[1]]) { type = SLASH[m[1]]; text = m[2]; }
  let content;
  if (type === "divider") content = {};
  else if (type === "checklist") content = { text, checked: false };
  else if (type === "heading") content = { text, level: m?.[1] === "/h1" ? 1 : 2 };
  else if (type === "image" || type === "embed") {
    const url = R.safeUrl(text.trim());
    if (!url) { toast("Enter an http(s) URL"); return; }
    content = { url, text: type === "embed" ? url : "" };
  } else content = { text };
  if (type !== "divider" && !text.trim() && type !== "checklist") { toast("Type some content first"); return; }
  await insertBlockAfter(null, type, content);
  $("blockText").value = "";
  if (type === "checklist") $("blockType").value = "checklist";
  $("blockText").focus();
};
$("blockText").addEventListener("focus", () => sendPresence(state.pageId, true));
$("blockText").addEventListener("blur", () => sendPresence(state.pageId, false));

// ── Export / publish / templates ─────────────────────────────────────────────
$("exportBtn").onclick = (e) => popupMenu(e.currentTarget, [
  { label: "Markdown (.md)", run: () => download(`${fileSafe(state.page.title)}.md`, R.toMarkdown(state.page, state.blocks), "text/markdown") },
  { label: "HTML document (.html)", run: () => download(`${fileSafe(state.page.title)}.html`, R.toHtmlDocument(state.page, state.blocks), "text/html") },
  { label: "PDF (print dialog)", run: () => printPage() },
  { label: "Kinynx JSON (re-importable)", run: async () => {
    const data = await api(`/pages/${state.pageId}/export`);
    download(`${fileSafe(state.page.title)}.kinynx.json`, JSON.stringify(data, null, 2), "application/json");
  } },
]);

function printPage() {
  const frame = h("iframe", { style: "position:fixed;width:0;height:0;border:0", sandbox: "allow-modals allow-same-origin" });
  document.body.append(frame);
  frame.srcdoc = R.toHtmlDocument(state.page, state.blocks);
  frame.onload = () => { frame.contentWindow.print(); setTimeout(() => frame.remove(), 1500); };
}

$("publishBtn").onclick = async () => {
  const slug = h("input", { placeholder: "custom-slug (optional)", pattern: "[a-z0-9-]{3,80}" });
  const pw = h("input", { type: "password", placeholder: "Password (optional, 8+ chars)", autocomplete: "new-password" });
  const v = await dialog("Publish page", h("div", { class: "stack" },
    h("p", { class: "small muted", style: "margin:0" }, "Anyone with the link can view a read-only copy. To let people edit, share an invite link (🔗) instead."),
    slug, pw), [
    { label: "Cancel", value: undefined },
    { label: "Unpublish", class: "ghost", value: "unpublish" },
    { label: "Publish", submit: true, value: "publish" },
  ]);
  if (v === "unpublish") { await api(`/pages/${state.pageId}/publish`, { method: "DELETE" }); toast("Unpublished"); return; }
  if (v !== "publish") return;
  const body = { seo: { title: state.page.title } };
  if (slug.value.trim()) body.slug = slug.value.trim().toLowerCase();
  if (pw.value) body.password = pw.value;
  const res = await api(`/pages/${state.pageId}/publish`, { method: "POST", body });
  const link = `${location.origin}/p/${res.slug}`;
  try { await navigator.clipboard.writeText(link); } catch {}
  dialog("Published 🎉", h("div", { class: "stack" }, h("input", { value: link, readOnly: true }),
    h("a", { href: link, target: "_blank", rel: "noopener" }, "Open public page ↗")), [{ label: "Done", value: true }]);
};

$("saveTplBtn").onclick = async () => {
  const { categories } = await api("/templates/categories");
  const name = h("input", { value: state.page.title, maxlength: "160", required: true });
  const desc = h("textarea", { rows: 3, maxlength: "2000", placeholder: "What is this template for?" });
  const cat = h("select", {}, categories.map((c) => h("option", { value: c }, c)));
  const ok = await dialog("Save as template", h("div", { class: "stack" }, name, desc, cat,
    h("p", { class: "small muted", style: "margin:0" }, "Publishes this page and its sub-pages to the template gallery. Download it later as a .template.zip to share.")), [
    { label: "Cancel", value: false }, { label: "Save template", submit: true, value: true },
  ]);
  if (!ok) return;
  await api("/templates", { method: "POST", body: { page_id: state.pageId, name: name.value.trim() || state.page.title, description: desc.value, category: cat.value } });
  toast("Template saved to gallery");
};

$("templatesBtn").onclick = async () => {
  if (!state.wsId) { toast("Create a workspace first"); return; }
  const file = h("input", { type: "file", accept: ".json,.zip,.md,.markdown,application/json,application/zip,text/markdown" });
  const search = h("input", { placeholder: "Search templates…", type: "search" });
  const results = h("div", { class: "list", style: "max-height:300px;overflow:auto" });
  const load = async () => {
    const { templates } = await api(`/templates?limit=30${search.value ? `&q=${encodeURIComponent(search.value)}` : ""}`);
    results.replaceChildren(...templates.map((t) => h("div", { class: "tpl" },
      h("div", {}, h("b", {}, t.name), h("div", { class: "small muted" }, `${t.category} · ${t.downloads ?? 0} uses · by ${short(t.author)}`)),
      h("span", { class: "row" },
        h("a", { class: "small", href: `/api/templates/${t.id}/download.zip`, title: "Download .template.zip" }, "⤓"),
        h("button", { style: "padding:5px 10px", type: "button", onclick: async () => {
          const res = await api(`/templates/${t.id}/import`, { method: "POST", body: { workspace_id: state.wsId } });
          $("dlg").close(); await loadPages(); openPage(res.page_id); toast("Template imported");
        } }, "Use")))));
    if (!templates.length) results.append(h("p", { class: "small muted" }, "No templates found."));
  };
  search.addEventListener("input", () => { clearTimeout(load.t); load.t = setTimeout(load, 250); });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const id = await importFile(f);
      $("dlg").close(); await loadPages(); openPage(id); toast(`Imported ${f.name}`);
    } catch (err) { toast(`Import failed: ${err.message}`); }
  };
  load();
  dialog("Templates & import", h("div", { class: "stack" },
    h("div", {}, h("p", { class: "small muted", style: "margin:0 0 6px" }, "Import a file: .template.zip, Kinynx .json export, or Markdown (.md). See docs/TEMPLATE_SPEC.md to author your own."), file),
    search, results), [{ label: "Close", value: undefined }]);
};

async function importFile(f) {
  if (f.size > 25 * 1024 * 1024) throw new Error("file is larger than 25 MB");
  const name = f.name.toLowerCase();
  if (name.endsWith(".zip")) {
    return (await api(`/workspaces/${state.wsId}/templates/import-zip`, { method: "POST", raw: await f.arrayBuffer() })).page_id;
  }
  const text = await f.text();
  let page;
  if (name.endsWith(".md") || name.endsWith(".markdown")) page = R.fromMarkdown(text);
  else {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
    page = data.page || data.content?.page || data; // kinynx export, template package, or bare page
  }
  if (!page || typeof page.title !== "string") throw new Error("unrecognised format");
  return (await api(`/workspaces/${state.wsId}/import`, { method: "POST", body: { page } })).page_id;
}

// ── Realtime: presence + live sync ───────────────────────────────────────────
function ensureRealtime() {
  if (!state.wsId || state.connectedWs === state.wsId) return;
  if (state.ws) { try { state.ws.close(); } catch {} }
  state.connectedWs = state.wsId;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/realtime?workspaceId=${state.wsId}&token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "presence") renderPresence(msg.users || []);
    else if (msg.pageId && msg.pageId === state.pageId && msg.by !== state.me?.email) scheduleRefresh();
  };
  ws.onclose = () => { if (state.connectedWs === state.wsId) { state.connectedWs = null; setTimeout(ensureRealtime, 3000); } };
}

// Don't clobber what the user is typing: apply remote changes once they blur.
function scheduleRefresh() {
  if (document.activeElement?.classList?.contains("ed")) state.pendingRefresh = true;
  else openPage(state.pageId);
}
function flushRefresh() {
  if (!state.pendingRefresh) return;
  state.pendingRefresh = false;
  setTimeout(() => { if (!document.activeElement?.classList?.contains("ed")) openPage(state.pageId); else state.pendingRefresh = true; }, 50);
}

function renderPresence(users) {
  const others = users.filter((u) => u.email && u.email !== state.me?.email);
  $("presence").replaceChildren(...others.slice(0, 6).map((u) =>
    h("span", { class: "avatar", style: `background:${R.colorFor(u.email)}`, title: `${u.email}${u.state === "editing" ? " (editing)" : ""}` },
      short(u.email).slice(0, 2).toUpperCase())));
}

function sendPresence(pageId, editing) {
  if (state.ws && state.ws.readyState === 1 && pageId) {
    state.ws.send(JSON.stringify({ type: "presence", pageId, state: editing ? "editing" : "viewing" }));
  }
}

// ── Comments ─────────────────────────────────────────────────────────────────
async function loadComments() {
  if (!state.pageId) return;
  $("commentsCard").classList.remove("hidden");
  const { comments } = await api(`/comments?target_type=page&target_id=${state.pageId}`);
  const list = $("comments");
  list.replaceChildren(...comments.map((c) => h("div", { class: "item", style: "cursor:default;align-items:flex-start" },
    h("span", { class: "dot", style: `background:${R.colorFor(c.author)};margin-top:7px` }),
    h("span", {}, h("b", { class: "small" }, short(c.author)), " ", c.body, c.resolved_at ? h("span", { class: "small muted" }, " (resolved)") : null))));
  if (!comments.length) list.append(h("p", { class: "small muted", style: "margin:0" }, "No comments yet."));
}
$("commentForm").onsubmit = async (e) => {
  e.preventDefault();
  const body = $("commentText").value.trim();
  if (!body || !state.pageId) return;
  await api("/comments", { method: "POST", body: { target_type: "page", target_id: state.pageId, body } });
  $("commentText").value = ""; toast("Comment added"); loadComments();
};
async function commentOnBlock(b) {
  const body = await promptText("Comment on block", `“${R.textOf(b).slice(0, 80) || b.type}”`, "", { maxlength: 5000 });
  if (!body) return;
  await api("/comments", { method: "POST", body: { target_type: "block", target_id: b.id, body } });
  toast("Comment added");
}

// ── Notifications ────────────────────────────────────────────────────────────
async function refreshNotifCount() {
  try {
    const { unread } = await api("/notifications/unread-count", { quiet: true });
    const badge = $("notifCount");
    badge.textContent = unread;
    badge.style.display = unread > 0 ? "inline-block" : "none";
  } catch {}
}
async function showNotifications() {
  const { notifications } = await api("/notifications?limit=20");
  const list = $("notifList");
  list.replaceChildren(...notifications.map((n) => h("div", { class: "item", style: n.read_at ? "" : "border-color:var(--accent)" },
    h("span", {}, "🔔"), h("span", { class: "small" }, h("b", {}, n.type), ` from ${short(n.actor || "system")}`, n.data?.excerpt ? ` — ${n.data.excerpt}` : ""))));
  if (!notifications.length) list.append(h("p", { class: "small muted" }, "Nothing yet."));
}
$("bell").onclick = async () => {
  const panel = $("notifPanel");
  if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  await showNotifications();
};
$("markAll").onclick = async () => { await api("/notifications/read-all", { method: "POST" }); await refreshNotifCount(); await showNotifications(); };

// ── Deep links: /invite/:token, /auth/magic/:token, /auth/reset/:token ──────
// Tokens are pulled from the path and immediately scrubbed from the address bar
// (and history) so they don't linger or leak via Referer.
function takeLinkToken() {
  const m = location.pathname.match(/^\/(invite|auth\/magic|auth\/reset)\/([A-Za-z0-9_-]{10,200})$/);
  if (!m) return null;
  history.replaceState(null, "", "/");
  return { kind: m[1], token: m[2] };
}

async function acceptPendingInvite() {
  let token;
  try { token = sessionStorage.getItem("kinynx_invite"); } catch {}
  if (!token) return;
  try { sessionStorage.removeItem("kinynx_invite"); } catch {}
  try {
    const res = await api("/invitations/accept", { method: "POST", body: { token } });
    state.orgId = res.organization_id; state.wsId = null;
    toast(`Joined as ${res.role}`);
    await loadOrgs();
  } catch {}
}

async function handleLink(link) {
  if (link.kind === "invite") {
    try { sessionStorage.setItem("kinynx_invite", link.token); } catch {}
    const info = await api(`/invitations/${encodeURIComponent(link.token)}`, { quiet: true }).catch(() => null);
    $("authNote").textContent = info
      ? `You've been invited to ${info.organization} as ${info.role}. Sign in or create an account to join.`
      : "This invitation is invalid or has expired.";
    $("authNote").classList.remove("hidden");
  } else if (link.kind === "auth/magic") {
    const data = await api("/auth/magic-link/verify", { method: "POST", body: { token: link.token } }).catch(() => null);
    if (data) { state.token = data.access_token; state.refresh = data.refresh_token; localStorage.setItem("kinynx_refresh", data.refresh_token); }
  } else if (link.kind === "auth/reset") {
    const pw = h("input", { type: "password", minlength: "8", autocomplete: "new-password", placeholder: "New password (8+ chars)", required: true });
    const v = await dialog("Choose a new password", pw, [{ label: "Cancel", value: undefined }, { label: "Set password", submit: true, value: () => pw.value }]);
    if (v && v.length >= 8) {
      await api("/auth/password/reset", { method: "POST", body: { token: link.token, password: v } })
        .then(() => toast("Password updated — sign in with your new password")).catch(() => {});
    }
  }
}

(async function init() {
  const link = takeLinkToken();
  if (link) await handleLink(link);
  if (state.refresh) { await boot(); return acceptPendingInvite(); }
  if (!localStorage.getItem("kinynx_refresh")) return;
  try { await refreshSession(); await boot(); await acceptPendingInvite(); }
  catch { localStorage.removeItem("kinynx_refresh"); }
})();
