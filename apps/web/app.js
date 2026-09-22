// Minimal vanilla-JS client for the Kinynx vertical slice.
// No build step: talks to the API through the Caddy reverse proxy at /api.
const API = ""; // same-origin via reverse proxy
const $ = (id) => document.getElementById(id);
const state = { token: null, refresh: null, orgId: null, wsId: null, pageId: null };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || `Error ${res.status}`);
    throw new Error(data.error || res.status);
  }
  return data;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function authenticate(path) {
  const email = $("email").value.trim();
  const password = $("password").value;
  const data = await api(path, { method: "POST", body: { email, password } });
  state.token = data.access_token;
  state.refresh = data.refresh_token;
  localStorage.setItem("kinynx_refresh", data.refresh_token);
  await boot();
}
$("loginBtn").onclick = () => authenticate("/auth/login").catch(() => {});
$("registerBtn").onclick = () => authenticate("/auth/register").catch(() => {});
$("logout").onclick = async () => {
  if (state.refresh) await api("/auth/logout", { method: "POST", body: { refresh_token: state.refresh } }).catch(() => {});
  localStorage.removeItem("kinynx_refresh");
  location.reload();
};

// Lightweight SSO hint: suggests IT check auto-discovery for known domains.
$("email").addEventListener("blur", () => {
  const domain = ($("email").value.split("@")[1] || "").toLowerCase();
  $("ssoHint").textContent = domain
    ? `If ${domain} uses SSO, your admin can enable auto sign-in (Enterprise).`
    : "";
});

// ── App bootstrapping ────────────────────────────────────────────────────────
async function boot() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  const me = await api("/auth/me");
  $("whoami").textContent = me.email;
  const info = await api("/system/info");
  $("edition").textContent = `${info.edition} Edition`;
  renderFeatures(info.features);
  await loadOrgs();
  await refreshNotifCount();
  if (!state.notifTimer) state.notifTimer = setInterval(refreshNotifCount, 20000);
}

function renderFeatures(features) {
  const wrap = $("features");
  wrap.innerHTML = "";
  Object.entries(features).forEach(([k, on]) => {
    const c = document.createElement("span");
    c.className = `chip ${on ? "on" : "off"}`;
    c.textContent = `${on ? "✓" : "○"} ${k}`;
    wrap.appendChild(c);
  });
}

async function loadOrgs() {
  const { organizations } = await api("/organizations");
  const list = $("orgs");
  list.innerHTML = "";
  organizations.forEach((o) => {
    const el = document.createElement("div");
    el.className = "item" + (o.id === state.orgId ? " active" : "");
    el.innerHTML = `<span>🏢</span><span>${o.name}</span><span class="spacer"></span><span class="small muted">${o.role}</span>`;
    el.onclick = () => { state.orgId = o.id; state.wsId = null; loadOrgs(); loadWorkspaces(); };
    list.appendChild(el);
  });
  if (!state.orgId && organizations[0]) { state.orgId = organizations[0].id; loadOrgs(); }
  if (state.orgId) loadWorkspaces();
}

$("addOrg").onclick = async () => {
  const name = $("newOrg").value.trim(); if (!name) return;
  await api("/organizations", { method: "POST", body: { name } });
  $("newOrg").value = ""; toast("Organization created"); loadOrgs();
};

async function loadWorkspaces() {
  const { workspaces } = await api(`/organizations/${state.orgId}/workspaces`);
  const list = $("workspaces"); list.innerHTML = "";
  workspaces.forEach((w) => {
    const el = document.createElement("div");
    el.className = "item" + (w.id === state.wsId ? " active" : "");
    el.innerHTML = `<span>🗂️</span><span>${w.name}</span>`;
    el.onclick = () => { state.wsId = w.id; loadWorkspaces(); loadPages(); };
    list.appendChild(el);
  });
  if (!state.wsId && workspaces[0]) { state.wsId = workspaces[0].id; loadWorkspaces(); }
  if (state.wsId) loadPages();
}

$("addWs").onclick = async () => {
  const name = $("newWs").value.trim(); if (!name || !state.orgId) return;
  await api(`/organizations/${state.orgId}/workspaces`, { method: "POST", body: { name } });
  $("newWs").value = ""; toast("Workspace created"); loadWorkspaces();
};

// ── Realtime: presence + live sync ───────────────────────────────────────────
function ensureRealtime() {
  if (!state.wsId || state.connectedWs === state.wsId) return;
  if (state.ws) { try { state.ws.close(); } catch {} }
  state.connectedWs = state.wsId;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/api/realtime?workspaceId=${state.wsId}&token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "presence") renderPresence(msg.users);
    else if (msg.pageId && msg.pageId === state.pageId) openPage(state.pageId); // live-sync current page
  };
  ws.onclose = () => { if (state.connectedWs === state.wsId) state.connectedWs = null; };
}

function renderPresence(users) {
  const others = users.filter((u) => u.email);
  const label = others
    .map((u) => `${u.email.split("@")[0]}${u.state === "editing" ? " ✎" : ""}`)
    .join(", ");
  $("presence").textContent = others.length ? `● ${others.length} here: ${label}` : "";
  $("presence").style.color = "var(--ok)";
}

function sendPresence(pageId, editing) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: "presence", pageId, state: editing ? "editing" : "viewing" }));
  }
}

$("invite").onclick = async () => {
  if (!state.orgId) return;
  const data = await api(`/organizations/${state.orgId}/invitations`, {
    method: "POST",
    body: { workspace_id: state.wsId, role: "editor", max_uses: 25 },
  });
  try { await navigator.clipboard.writeText(data.link); toast("Invite link copied"); }
  catch { toast(data.link); }
};

async function loadPages() {
  ensureRealtime();
  const { pages } = await api(`/workspaces/${state.wsId}/pages`);
  const list = $("pages"); list.innerHTML = "";
  const byParent = {};
  pages.forEach((p) => { (byParent[p.parent_id || "root"] ||= []).push(p); });
  const render = (parent, depth) => (byParent[parent] || []).forEach((p) => {
    const el = document.createElement("div");
    el.className = "item" + (depth ? " tree-child" : "") + (p.id === state.pageId ? " active" : "");
    el.innerHTML = `<span>${p.icon || "📄"}</span><span>${p.title}</span>`;
    el.onclick = () => openPage(p.id);
    list.appendChild(el);
    render(p.id, depth + 1);
  });
  render("root", 0);
}

$("addPage").onclick = async () => {
  const title = $("newPage").value.trim(); if (!title || !state.wsId) return;
  await api(`/workspaces/${state.wsId}/pages`, { method: "POST", body: { title } });
  $("newPage").value = ""; toast("Page created"); loadPages();
};

async function openPage(id) {
  state.pageId = id;
  sendPresence(id, false);
  const { page, blocks } = await api(`/pages/${id}`);
  $("pageTitle").value = page.title;
  $("pageMeta").textContent = `${blocks.length} block(s)`;
  const wrap = $("blocks"); wrap.innerHTML = "";
  blocks.forEach((b) => {
    const el = document.createElement("div");
    el.className = "block";
    el.innerHTML = `<span class="btype">${b.type}</span><span>${b.content.text || b.content.code || "—"}</span>`;
    wrap.appendChild(el);
  });
  loadPages();
  loadComments();
}

// ── Comments ─────────────────────────────────────────────────────────────────
async function loadComments() {
  if (!state.pageId) return;
  $("commentsCard").style.display = "block";
  const { comments } = await api(`/comments?target_type=page&target_id=${state.pageId}`);
  const list = $("comments"); list.innerHTML = "";
  if (!comments.length) list.innerHTML = '<p class="small muted">No comments yet.</p>';
  comments.forEach((c) => {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<span>💬</span><span><b class="small">${(c.author || "?").split("@")[0]}</b> ${escapeHtmlLocal(c.body)}${c.resolved_at ? ' <span class="small muted">(resolved)</span>' : ""}</span>`;
    list.appendChild(el);
  });
}
$("addComment").onclick = async () => {
  const body = $("commentText").value.trim();
  if (!body || !state.pageId) return;
  await api("/comments", { method: "POST", body: { target_type: "page", target_id: state.pageId, body } });
  $("commentText").value = ""; toast("Comment added"); loadComments();
};
function escapeHtmlLocal(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

// ── Notifications ────────────────────────────────────────────────────────────
async function refreshNotifCount() {
  try {
    const { unread } = await api("/notifications/unread-count");
    const badge = $("notifCount");
    badge.textContent = unread;
    badge.style.display = unread > 0 ? "inline-block" : "none";
  } catch {}
}
$("bell").onclick = async () => {
  const panel = $("notifPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  const { notifications } = await api("/notifications?limit=20");
  const list = $("notifList"); list.innerHTML = "";
  if (!notifications.length) list.innerHTML = '<p class="small muted">Nothing yet.</p>';
  notifications.forEach((n) => {
    const el = document.createElement("div");
    el.className = "item"; if (!n.read_at) el.style.borderColor = "var(--accent)";
    const who = (n.actor || "system").split("@")[0];
    el.innerHTML = `<span>🔔</span><span class="small"><b>${n.type}</b> from ${who}${n.data?.excerpt ? ` — ${escapeHtmlLocal(n.data.excerpt)}` : ""}</span>`;
    list.appendChild(el);
  });
};
$("markAll").onclick = async () => { await api("/notifications/read-all", { method: "POST" }); await refreshNotifCount(); $("bell").onclick(); $("bell").onclick(); };

$("pageTitle").addEventListener("change", async () => {
  if (!state.pageId) return;
  await api(`/pages/${state.pageId}`, { method: "PATCH", body: { title: $("pageTitle").value } });
  toast("Saved"); loadPages();
});

$("blockText").addEventListener("focus", () => sendPresence(state.pageId, true));
$("blockText").addEventListener("blur", () => sendPresence(state.pageId, false));

$("addBlock").onclick = async () => {
  if (!state.pageId) { toast("Open a page first"); return; }
  const type = $("blockType").value;
  const text = $("blockText").value;
  const content = type === "code" ? { code: text } : { text };
  await api(`/pages/${state.pageId}/blocks`, { method: "POST", body: { type, content } });
  $("blockText").value = ""; openPage(state.pageId);
};

// ── Restore session on load ──────────────────────────────────────────────────
(async function init() {
  const refresh = localStorage.getItem("kinynx_refresh");
  if (!refresh) return;
  try {
    const data = await api("/auth/refresh", { method: "POST", body: { refresh_token: refresh } });
    state.token = data.access_token; state.refresh = data.refresh_token;
    localStorage.setItem("kinynx_refresh", data.refresh_token);
    await boot();
  } catch { localStorage.removeItem("kinynx_refresh"); }
})();
