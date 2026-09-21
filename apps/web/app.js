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

async function loadPages() {
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
}

$("pageTitle").addEventListener("change", async () => {
  if (!state.pageId) return;
  await api(`/pages/${state.pageId}`, { method: "PATCH", body: { title: $("pageTitle").value } });
  toast("Saved"); loadPages();
});

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
