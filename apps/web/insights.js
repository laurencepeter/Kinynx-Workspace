// Kinynx Insights — dashboards, progress tracking, workflow editor and data
// grid over the same API. No build step.
// SECURITY: authorization happens server-side; all user text is rendered via
// textContent / DOM APIs only (never innerHTML).
const C = window.KinynxCharts;
const $ = (id) => document.getElementById(id);
const state = {
  token: null, refresh: null, wsId: null, settings: {}, workspaces: [],
  databases: [], schemas: new Map(), dashboards: [], dashId: null, dash: null, tab: "dashboards",
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ── DOM helpers ──────────────────────────────────────────────────────────────
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
const opt = (value, label, selected) => h("option", { value, selected: !!selected }, label);
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
const uid = () => Math.random().toString(36).slice(2, 10);

// ── API with transparent refresh ─────────────────────────────────────────────
async function refreshSession() {
  const refresh = state.refresh || store.get("kinynx_refresh");
  if (!refresh) throw new Error("no session");
  const res = await fetch("/api/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: refresh }) });
  if (!res.ok) { store.del("kinynx_refresh"); throw new Error("session expired"); }
  const data = await res.json();
  state.token = data.access_token; state.refresh = data.refresh_token;
  store.set("kinynx_refresh", data.refresh_token);
}
async function api(path, { method = "GET", body, blob, quiet, retry = true } = {}) {
  const headers = state.token ? { authorization: `Bearer ${state.token}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401 && retry && state.refresh) { await refreshSession(); return api(path, { method, body, blob, quiet, retry: false }); }
  if (res.status === 204) return null;
  if (res.ok && blob) return { blob: await res.blob(), name: /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.details?.[0] ? `${data.error}: ${data.details[0].path} ${data.details[0].message}` : data.error || `Error ${res.status}`;
    if (!quiet) toast(msg);
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return data;
}
function saveBlob({ blob, name }) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name || "download" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Dialog ───────────────────────────────────────────────────────────────────
function dialog(title, body, { submit = "Save", danger = false } = {}) {
  const dlg = $("dlg");
  return new Promise((resolve) => {
    const form = h("form", { method: "dialog" },
      h("h3", { style: "margin-top:0" }, title), body,
      h("div", { class: "row", style: "justify-content:flex-end;margin-top:16px" },
        h("button", { type: "button", class: "ghost", onclick: () => { dlg.close(); resolve(false); } }, "Cancel"),
        h("button", { type: "submit", style: danger ? "background:var(--bad)" : "" }, submit)));
    form.addEventListener("submit", (e) => { e.preventDefault(); dlg.close(); resolve(true); });
    dlg.replaceChildren(form);
    dlg.onclose = () => resolve(false);
    dlg.showModal();
    form.querySelector("input,select")?.focus();
  });
}
const field = (label, control) => h("div", { class: "f" }, h("label", {}, label), control);

// ── Auth & boot ──────────────────────────────────────────────────────────────
$("loginBtn").onclick = async () => {
  try {
    const d = await api("/auth/login", { method: "POST", body: { email: $("email").value.trim(), password: $("password").value } });
    state.token = d.access_token; state.refresh = d.refresh_token;
    store.set("kinynx_refresh", d.refresh_token);
    await boot();
  } catch { /* toast shown */ }
};

async function boot() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("workspace").classList.remove("hidden");
  $("customizeBtn").classList.remove("hidden");
  const { organizations } = await api("/organizations");
  const sel = $("workspace");
  sel.replaceChildren();
  for (const o of organizations) {
    const { workspaces } = await api(`/organizations/${o.id}/workspaces`);
    for (const w of workspaces) { state.workspaces.push(w); sel.append(opt(w.id, `${o.name} / ${w.name}`)); }
  }
  const remembered = store.get("kinynx_insights_ws");
  if (remembered && state.workspaces.some((w) => w.id === remembered)) sel.value = remembered;
  if (sel.value) await selectWorkspace(sel.value);
  else $("dashGrid").replaceChildren(h("div", { class: "empty-state", style: "grid-column:1/-1" }, "Create a workspace in the docs app first."));
}
$("workspace").onchange = () => selectWorkspace($("workspace").value);

async function selectWorkspace(id) {
  state.wsId = id;
  store.set("kinynx_insights_ws", id);
  const { workspace } = await api(`/workspaces/${id}`);
  state.settings = workspace.settings || {};
  applySettings();
  state.schemas.clear();
  await loadDatabases();
  await loadDashboards();
  await showTab(state.tab);
}

function applySettings() {
  const s = state.settings;
  const root = document.documentElement;
  const theme = s.theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : s.theme || "dark";
  root.dataset.theme = theme;
  root.dataset.density = s.density || "comfortable";
  if (s.accent) root.style.setProperty("--accent", s.accent); else root.style.removeProperty("--accent");
  C.setPalette(s.chart_palette);
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("hidden", s.nav?.[a.dataset.nav] === false && a.dataset.nav !== "insights");
}
const noun = (plural) => { const n = state.settings.record_noun || "Record"; return plural ? `${n}s` : n; };

// ── Tabs ─────────────────────────────────────────────────────────────────────
for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => showTab(b.dataset.tab);
async function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const t of ["dashboards", "progress", "workflow", "data"]) $(`tab-${t}`).classList.toggle("hidden", t !== tab);
  if (tab === "dashboards") await openDashboard(state.dashId);
  if (tab === "progress") await renderProgress();
  if (tab === "workflow") await renderWorkflow();
  if (tab === "data") await renderData();
}

// ── Databases ────────────────────────────────────────────────────────────────
async function loadDatabases() {
  const { databases } = await api(`/workspaces/${state.wsId}/databases`);
  state.databases = databases;
  const remembered = store.get("kinynx_insights_db");
  for (const id of ["progDb", "wfDb", "dataDb"]) {
    const sel = $(id);
    const prev = sel.value || remembered;
    sel.replaceChildren(...databases.map((d) => opt(d.id, d.name)));
    if (databases.some((d) => d.id === prev)) sel.value = prev;
  }
}
for (const id of ["progDb", "wfDb", "dataDb"]) {
  $(id).onchange = () => { store.set("kinynx_insights_db", $(id).value); showTab(state.tab); };
}
$("progDays").onchange = () => renderProgress();

async function schema(dbId, fresh = false) {
  if (!fresh && state.schemas.has(dbId)) return state.schemas.get(dbId);
  const s = await api(`/databases/${dbId}`);
  state.schemas.set(dbId, s);
  return s;
}
const dbName = (id) => state.databases.find((d) => d.id === id)?.name || "—";

// ── Dashboards ───────────────────────────────────────────────────────────────
async function loadDashboards() {
  const { dashboards } = await api(`/workspaces/${state.wsId}/dashboards`);
  state.dashboards = dashboards;
  if (!dashboards.some((d) => d.id === state.dashId)) {
    state.dashId = dashboards.find((d) => d.id === state.settings.default_dashboard_id)?.id || dashboards[0]?.id || null;
  }
  renderDashList();
}
function renderDashList() {
  $("dashList").replaceChildren(...state.dashboards.map((d) =>
    h("div", { class: `item${d.id === state.dashId ? " on" : ""}`, tabindex: "0", role: "button", onclick: () => openDashboard(d.id), onkeydown: (e) => { if (e.key === "Enter") openDashboard(d.id); } },
      h("span", {}, d.id === state.settings.default_dashboard_id ? "★" : "▦"), h("span", {}, d.name))));
}

$("newDash").onclick = async () => {
  const name = h("input", { value: "Team overview", maxlength: "120" });
  const desc = h("input", { placeholder: "Optional description", maxlength: "500" });
  if (!(await dialog("New dashboard", h("div", {}, field("Name", name), field("Description", desc)), { submit: "Create" }))) return;
  const { dashboard } = await api(`/workspaces/${state.wsId}/dashboards`, { method: "POST", body: { name: name.value.trim() || "Dashboard", description: desc.value.trim() } });
  state.dashId = dashboard.id;
  await loadDashboards();
  await openDashboard(dashboard.id);
};

async function openDashboard(id) {
  state.dashId = id;
  renderDashList();
  const grid = $("dashGrid");
  const controls = ["addWidget", "reportBtn", "reportFmt", "dashMenu"];
  if (!id) {
    $("dashTitle").textContent = "No dashboards yet";
    $("dashDesc").textContent = "Create one, or start from the project tracker template.";
    controls.forEach((c) => $(c).classList.add("hidden"));
    grid.replaceChildren(h("div", { class: "empty-state", style: "grid-column:1/-1" },
      h("p", {}, "Dashboards turn your databases into charts, KPIs, tables and progress views."),
      h("button", { onclick: () => $("starter").click() }, "✦ Create the project tracker starter")));
    return;
  }
  controls.forEach((c) => $(c).classList.remove("hidden"));
  const [{ dashboard }, data] = await Promise.all([api(`/dashboards/${id}`), api(`/dashboards/${id}/data`)]);
  state.dash = dashboard;
  await Promise.all([...new Set(dashboard.widgets.map((w) => w.database_id))].filter((d) => state.databases.some((x) => x.id === d)).map((d) => schema(d)));
  $("dashTitle").textContent = dashboard.name;
  $("dashDesc").textContent = dashboard.description;
  if (!data.widgets.length) {
    grid.replaceChildren(h("div", { class: "empty-state", style: "grid-column:1/-1" }, h("p", {}, "This dashboard is empty."), h("button", { onclick: () => editWidget() }, "+ Add a widget")));
    return;
  }
  const cards = data.widgets.map(widgetCard);
  grid.replaceChildren(...cards.map((c) => c.card));
  cards.forEach((c) => c.draw()); // after insertion, so charts know their width
}

function widgetCard(w) {
  const body = h("div");
  const card = h("div", { class: "card", style: `grid-column:span ${w.w || 2}` },
    h("div", { class: "head" },
      h("div", { style: "min-width:0" }, h("h3", {}, w.title), h("div", { class: "sub" }, w.database)),
      h("span", { class: "spacer" }),
      h("button", { class: "icon", "aria-label": `Options for ${w.title}`, onclick: (e) => widgetMenu(e.currentTarget, w) }, "⋯")),
    body);
  const draw = () => {
    if (w.error) body.append(h("div", { class: "kx-empty" }, w.error));
    else if (w.progress) renderProgressWidget(body, w.progress);
    else if (w.chart) {
      const fn = { bar: C.bar, column: C.column, stacked: C.stacked, line: C.line, area: C.area, donut: C.donut, table: C.table, number: C.number }[w.type];
      fn(body, w.chart, { label: metricLabel(w) });
    }
  };
  return { card, draw };
}
function metricLabel(w) {
  const m = state.dash?.widgets.find((x) => x.id === w.id)?.query?.metric;
  return m && m.agg !== "count" ? `${m.agg} of ${propName(w.database_id, m.property)}` : `Count of ${noun(true).toLowerCase()}`;
}
function propName(dbId, pid) {
  if (pid === "created_at") return "Created";
  if (pid === "updated_at") return "Updated";
  return state.schemas.get(dbId)?.properties.find((p) => p.id === pid)?.name || "value";
}

function renderProgressWidget(el, p) {
  const tiles = h("div", { class: "tiles", style: "grid-template-columns:repeat(3,1fr)" },
    tile("Complete", `${p.completion_pct}%`), tile("Per week", C.fmt(p.throughput_per_week)), tile("Overdue", C.fmt(p.overdue)));
  el.append(tiles, stageBars(p.by_stage));
}
function tile(l, v, hero) { return h("div", { class: `tile${hero ? " hero" : ""}` }, h("div", { class: "l" }, l), h("div", { class: "v" }, v)); }
function stageBars(stages) {
  const max = Math.max(1, ...stages.map((s) => Math.max(s.count, s.wip_limit || 0)));
  return h("div", { class: "stack" }, ...stages.map((s) =>
    h("div", {},
      h("div", { class: "row small", style: "justify-content:space-between" },
        h("span", { class: "kx-li" }, h("span", { class: "kx-sw", style: `background:${/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#888"}` }), s.name),
        h("span", { class: "muted" }, s.wip_limit ? `${s.count} / ${s.wip_limit} WIP${s.count > s.wip_limit ? " ⚠" : ""}` : String(s.count))),
      C.meter((s.count / max) * 100, { limit: s.wip_limit, value: s.count }))));
}

function popup(anchor, items) {
  document.querySelector(".kx-pop")?.remove();
  const r = anchor.getBoundingClientRect();
  const menu = h("div", { class: "kx-pop card", style: `position:fixed;z-index:40;top:${r.bottom + 4}px;left:${Math.max(8, r.right - 200)}px;width:200px;padding:6px` },
    ...items.map(([label, fn]) => h("div", { class: "side" }, h("div", { class: "item", role: "button", tabindex: "0", onclick: () => { menu.remove(); fn(); } }, label))));
  menu.querySelectorAll(".side").forEach((s) => { s.style.cssText = "border:0;padding:0;background:none"; });
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

async function saveWidgets(widgets) {
  const { dashboard } = await api(`/dashboards/${state.dashId}`, { method: "PATCH", body: { widgets } });
  state.dash = dashboard;
  await openDashboard(state.dashId);
}
function widgetMenu(anchor, w) {
  const list = state.dash.widgets;
  const i = list.findIndex((x) => x.id === w.id);
  const move = (d) => { const c = [...list]; const [it] = c.splice(i, 1); c.splice(Math.max(0, Math.min(c.length, i + d)), 0, it); return saveWidgets(c); };
  const size = (d) => saveWidgets(list.map((x) => (x.id === w.id ? { ...x, w: Math.max(1, Math.min(4, (x.w || 2) + d)) } : x)));
  popup(anchor, [
    ["✎ Edit", () => editWidget(list[i])],
    ["⇔ Wider", () => size(1)], ["⇆ Narrower", () => size(-1)],
    ["← Move earlier", () => move(-1)], ["→ Move later", () => move(1)],
    ["⧉ Duplicate", () => saveWidgets([...list.slice(0, i + 1), { ...list[i], id: uid(), title: `${list[i].title} copy` }, ...list.slice(i + 1)])],
    ["✕ Remove", () => saveWidgets(list.filter((x) => x.id !== w.id))],
  ]);
}

$("addWidget").onclick = () => editWidget();
$("dashMenu").onclick = (e) => popup(e.currentTarget, [
  ["✎ Rename", async () => {
    const name = h("input", { value: state.dash.name, maxlength: "120" });
    const desc = h("input", { value: state.dash.description, maxlength: "500" });
    if (!(await dialog("Edit dashboard", h("div", {}, field("Name", name), field("Description", desc))))) return;
    await api(`/dashboards/${state.dashId}`, { method: "PATCH", body: { name: name.value.trim(), description: desc.value.trim() } });
    await loadDashboards(); await openDashboard(state.dashId);
  }],
  ["★ Set as default", async () => {
    const { settings } = await api(`/workspaces/${state.wsId}/settings`, { method: "PATCH", body: { default_dashboard_id: state.dashId } });
    state.settings = settings; renderDashList(); toast("Default dashboard set");
  }],
  ["✕ Delete dashboard", async () => {
    if (!(await dialog("Delete dashboard?", h("p", {}, `“${state.dash.name}” and its widgets will be removed. Data is not affected.`), { submit: "Delete", danger: true }))) return;
    await api(`/dashboards/${state.dashId}`, { method: "DELETE" });
    state.dashId = null; await loadDashboards(); await openDashboard(state.dashId);
  }],
]);
$("reportBtn").onclick = async () => {
  saveBlob(await api(`/dashboards/${state.dashId}/report?format=${$("reportFmt").value}`, { blob: true }));
  toast("Report generated");
};

const WIDGET_TYPES = [["bar", "Bar (ranked)"], ["column", "Column"], ["stacked", "Stacked column"], ["line", "Line"], ["area", "Area"], ["donut", "Donut"], ["number", "Number (KPI)"], ["table", "Table"], ["progress", "Workflow progress"]];
const OPS = [["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["empty", "is empty"], ["not_empty", "is not empty"], ["within_days", "within days"]];

async function editWidget(existing) {
  if (!state.databases.length) return toast("Create a database first (Data tab)");
  const w = existing ? structuredClone(existing) : { id: uid(), title: "", type: "bar", database_id: $("dataDb").value || state.databases[0].id, query: { filters: [], metric: { agg: "count" } }, w: 2, days: 30 };
  w.query ??= {}; w.query.filters ??= []; w.query.metric ??= { agg: "count" };

  const title = h("input", { value: w.title, placeholder: "e.g. Open work by owner", maxlength: "120", required: true });
  const type = h("select", {}, ...WIDGET_TYPES.map(([v, l]) => opt(v, l, v === w.type)));
  const db = h("select", {}, ...state.databases.map((d) => opt(d.id, d.name, d.id === w.database_id)));
  const width = h("select", {}, ...[1, 2, 3, 4].map((n) => opt(String(n), `${n} / 4 width`, n === (w.w || 2))));
  const groupBy = h("select"), bucket = h("select"), splitBy = h("select"), agg = h("select"), metricProp = h("select"), sort = h("select");
  const cumulative = h("input", { type: "checkbox", checked: !!w.query.cumulative });
  const filtersBox = h("div", { class: "filters" });
  const queryBox = h("div");

  async function fill() {
    const { properties } = await schema(db.value);
    const groupable = properties.filter((p) => ["select", "multi_select", "checkbox", "text", "person", "date", "created_time", "updated_time"].includes(p.type));
    const numeric = properties.filter((p) => ["number", "formula", "rollup"].includes(p.type));
    const sys = [["created_at", "Created date"], ["updated_at", "Updated date"]];
    groupBy.replaceChildren(opt("", "— none —"), ...groupable.map((p) => opt(p.id, p.name, p.id === w.query.group_by)), ...sys.map(([v, l]) => opt(v, l, v === w.query.group_by)));
    bucket.replaceChildren(...["day", "week", "month", "quarter", "year"].map((b) => opt(b, b, b === (w.query.bucket || "week"))));
    splitBy.replaceChildren(opt("", "— none —"), ...groupable.filter((p) => p.type !== "date").map((p) => opt(p.id, p.name, p.id === w.query.split_by)));
    agg.replaceChildren(...["count", "sum", "avg", "min", "max"].map((a) => opt(a, a, a === w.query.metric.agg)));
    metricProp.replaceChildren(...numeric.map((p) => opt(p.id, p.name, p.id === w.query.metric.property)));
    sort.replaceChildren(...[["natural", "Natural"], ["value_desc", "Largest first"], ["value_asc", "Smallest first"], ["label", "A → Z"]].map(([v, l]) => opt(v, l, v === (w.query.sort || "natural"))));
    renderFilters(properties);
    sync();
  }
  function sync() {
    const isDate = ["created_at", "updated_at"].includes(groupBy.value) || state.schemas.get(db.value)?.properties.find((p) => p.id === groupBy.value)?.type === "date";
    bucket.parentElement.classList.toggle("hidden", !isDate);
    metricProp.parentElement.classList.toggle("hidden", agg.value === "count");
    queryBox.classList.toggle("hidden", type.value === "progress");
  }
  function renderFilters(properties) {
    const fields = [...properties.map((p) => [p.id, p.name]), ["title", "Title"], ["created_at", "Created date"], ["updated_at", "Updated date"]];
    filtersBox.replaceChildren(...w.query.filters.map((f, i) => {
      const p = h("select", { onchange: () => { f.property = p.value; } }, ...fields.map(([v, l]) => opt(v, l, v === f.property)));
      const o = h("select", { onchange: () => { f.op = o.value; } }, ...OPS.map(([v, l]) => opt(v, l, v === f.op)));
      const v = h("input", { value: f.value ?? "", placeholder: "value", style: "flex:1;min-width:80px", oninput: () => { f.value = v.value; } });
      return h("div", { class: "row" }, p, o, v, h("button", { type: "button", class: "icon", "aria-label": "Remove filter", onclick: () => { w.query.filters.splice(i, 1); renderFilters(properties); } }, "✕"));
    }), h("button", { type: "button", class: "ghost small", onclick: () => { w.query.filters.push({ property: fields[0][0], op: "eq", value: "" }); renderFilters(properties); } }, "+ Filter"));
  }
  db.onchange = () => { w.query = { filters: [], metric: { agg: "count" } }; fill(); };
  [groupBy, agg, type].forEach((s) => s.addEventListener("change", sync));

  queryBox.append(
    h("div", { class: "row" }, field("Group by", groupBy), field("Date bucket", bucket), field("Split into series", splitBy)),
    h("div", { class: "row" }, field("Measure", agg), field("Of property", metricProp), field("Sort", sort)),
    h("label", { class: "row small", style: "margin-bottom:12px" }, cumulative, "Running total (cumulative)"),
    h("label", {}, "Filters (all must match)"), filtersBox);
  await fill();
  const ok = await dialog(existing ? "Edit widget" : "Add widget", h("div", {}, field("Title", title), h("div", { class: "row" }, field("Visual", type), field("Database", db), field("Size", width)), queryBox), { submit: existing ? "Save" : "Add" });
  if (!ok) return;

  const q = { filters: w.query.filters.filter((f) => f.property).map((f) => ({ ...f, value: ["gt", "gte", "lt", "lte", "within_days"].includes(f.op) && f.value !== "" && !Number.isNaN(Number(f.value)) ? Number(f.value) : f.value })), metric: { agg: agg.value }, sort: sort.value, cumulative: cumulative.checked };
  if (groupBy.value) q.group_by = groupBy.value;
  if (!bucket.parentElement.classList.contains("hidden")) q.bucket = bucket.value;
  if (splitBy.value) q.split_by = splitBy.value;
  if (agg.value !== "count") { if (!metricProp.value) return toast("Pick a number property to measure"); q.metric.property = metricProp.value; }
  const next = { id: w.id, title: title.value.trim() || "Untitled", type: type.value, database_id: db.value, query: q, w: Number(width.value), days: w.days || 30 };
  const list = state.dash.widgets;
  await saveWidgets(existing ? list.map((x) => (x.id === w.id ? next : x)) : [...list, next]);
}

// ── Starter template: tracker database + workflow + dashboard ────────────────
$("starter").onclick = async () => {
  const name = h("input", { value: "Projects", maxlength: "160" });
  const seed = h("input", { type: "checkbox", checked: true });
  if (!(await dialog("Project tracker starter", h("div", {},
    h("p", { class: "muted small" }, "Creates a database (Status, Points, Due, Owner, Tags), a 5-stage workflow with WIP limits, and a dashboard with progress, charts and a table."),
    field("Database name", name), h("label", { class: "row small" }, seed, "Add a few sample items")), { submit: "Create" }))) return;
  const { database: d } = await api(`/workspaces/${state.wsId}/databases`, { method: "POST", body: { name: name.value.trim() || "Projects" } });
  const prop = async (name, type, config = {}) => (await api(`/databases/${d.id}/properties`, { method: "POST", body: { name, type, config } })).property;
  const status = await prop("Status", "select", { options: [] });
  const points = await prop("Points", "number");
  const due = await prop("Due", "date");
  const owner = await prop("Owner", "select", { options: [{ name: "Alex", color: "#3987e5" }, { name: "Sam", color: "#d95926" }, { name: "Riley", color: "#199e70" }] });
  const tags = await prop("Tags", "multi_select", { options: [{ name: "Design" }, { name: "API" }, { name: "Docs" }] });
  const stages = [
    { name: "Backlog", color: "#8a8a85", category: "todo", wip_limit: null },
    { name: "Todo", color: "#3987e5", category: "todo", wip_limit: null },
    { name: "In progress", color: "#c98500", category: "active", wip_limit: 3 },
    { name: "Review", color: "#9085e9", category: "active", wip_limit: 2 },
    { name: "Done", color: "#199e70", category: "done", wip_limit: null },
  ];
  await api(`/databases/${d.id}/workflow`, { method: "PUT", body: {
    status_property_id: status.id, due_property_id: due.id, stages, enforce: true,
    transitions: { Backlog: ["Todo"], Todo: ["In progress", "Backlog"], "In progress": ["Review", "Todo"], Review: ["Done", "In progress"], Done: ["Review"] },
  } });
  if (seed.checked) {
    const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const items = [
      ["Design system tokens", 5, "Alex", ["Design"], ["Todo", "In progress", "Review", "Done"], -3],
      ["Auth API hardening", 8, "Sam", ["API"], ["Todo", "In progress", "Review"], 2],
      ["Onboarding docs", 3, "Riley", ["Docs"], ["Todo", "In progress"], -1],
      ["Chart widgets", 5, "Alex", ["Design", "API"], ["Todo", "In progress", "Review", "Done"], 1],
      ["Report export", 3, "Sam", ["API"], ["Todo"], 6],
      ["Mobile layout pass", 8, "Riley", ["Design"], [], 12],
    ];
    for (const [title, pts, who, tg, path, dueIn] of items) {
      const { record } = await api(`/databases/${d.id}/records`, { method: "POST", body: { values: { title, [status.id]: "Backlog", [points.id]: pts, [owner.id]: who, [tags.id]: tg, [due.id]: day(dueIn) } } });
      for (const st of path) await api(`/records/${record.id}`, { method: "PATCH", body: { values: { [status.id]: st } }, quiet: true }).catch(() => {});
    }
  }
  const { dashboard } = await api(`/workspaces/${state.wsId}/dashboards`, { method: "POST", body: {
    name: `${d.name} overview`, description: "Workflow progress, workload and delivery at a glance.",
    widgets: [
      { id: uid(), title: "Delivery progress", type: "progress", database_id: d.id, w: 2 },
      { id: uid(), title: "Items by stage", type: "donut", database_id: d.id, query: { group_by: status.id }, w: 2 },
      { id: uid(), title: "Total points", type: "number", database_id: d.id, query: { metric: { agg: "sum", property: points.id } }, w: 1 },
      { id: uid(), title: "Points by owner and stage", type: "bar", database_id: d.id, query: { group_by: owner.id, split_by: status.id, metric: { agg: "sum", property: points.id } }, w: 3 },
      { id: uid(), title: "Items created (running total)", type: "area", database_id: d.id, query: { group_by: "created_at", bucket: "day", cumulative: true }, w: 2 },
      { id: uid(), title: "Work by tag", type: "table", database_id: d.id, query: { group_by: tags.id, metric: { agg: "sum", property: points.id }, sort: "value_desc" }, w: 2 },
    ],
  } });
  await loadDatabases();
  state.dashId = dashboard.id;
  await loadDashboards();
  await showTab("dashboards");
  toast("Project tracker ready");
};

// ── Progress tab ─────────────────────────────────────────────────────────────
async function renderProgress() {
  const body = $("progBody");
  const id = $("progDb").value;
  if (!id) return body.replaceChildren(h("div", { class: "empty-state" }, "No databases yet."));
  let p;
  try { p = await api(`/databases/${id}/progress?days=${$("progDays").value}`, { quiet: true }); } catch (e) {
    if (e.status !== 404) return toast(e.message);
    return body.replaceChildren(h("div", { class: "empty-state" }, h("p", {}, "Progress tracking needs a workflow on this database."), h("button", { onclick: () => showTab("workflow") }, "Set up a workflow")));
  }
  const burn = h("div"), stages = h("div"), thru = h("div");
  body.replaceChildren(...[
    h("div", { class: "tiles" },
      tile("Complete", `${p.completion_pct}%`, true),
      tile(`Open ${noun(true).toLowerCase()}`, C.fmt(p.total - p.by_category.done)),
      tile("Throughput / week", C.fmt(p.throughput_per_week)),
      tile("Lead time (days)", p.lead_time_days ?? "—"),
      tile("Cycle time (days)", p.cycle_time_days ?? "—"),
      tile("Overdue", C.fmt(p.overdue)),
      tile("Forecast done", p.forecast_done_date ?? "—")),
    p.wip_breaches.length ? h("p", { class: "pill", style: "margin-bottom:12px" }, `⚠ Over WIP limit: ${p.wip_breaches.join(", ")}`) : null,
    h("div", { class: "grid" },
      h("div", { class: "card", style: "grid-column:span 3" }, h("div", { class: "head" }, h("h3", {}, "Burn-up: scope vs done")), burn),
      h("div", { class: "card" }, h("div", { class: "head" }, h("h3", {}, "Stages & WIP")), stages),
      h("div", { class: "card", style: "grid-column:span 4" }, h("div", { class: "head" }, h("h3", {}, "Completed per day")), thru))].filter(Boolean));
  const labels = p.burnup.map((d) => d.date);
  C.line(burn, { labels, series: [{ name: "Scope", color: C.DEFAULT_PALETTE[0], data: p.burnup.map((d) => d.scope) }, { name: "Done", color: C.DEFAULT_PALETTE[2], data: p.burnup.map((d) => d.done) }] });
  stages.append(stageBars(p.by_stage));
  C.column(thru, { labels, series: [{ name: "Completed", color: C.DEFAULT_PALETTE[2], data: p.burnup.map((d) => d.completed) }] });
}

// ── Workflow tab ─────────────────────────────────────────────────────────────
async function renderWorkflow() {
  const body = $("wfBody");
  const id = $("wfDb").value;
  if (!id) return body.replaceChildren(h("div", { class: "empty-state" }, "No databases yet."));
  const s = await schema(id, true);
  const { workflow } = await api(`/databases/${id}/workflow`);
  const selects = s.properties.filter((p) => p.type === "select");
  const dates = s.properties.filter((p) => p.type === "date");
  if (!selects.length) {
    return body.replaceChildren(h("div", { class: "empty-state" }, h("p", {}, "A workflow runs on a select property (e.g. Status)."),
      h("button", { onclick: async () => { await api(`/databases/${id}/properties`, { method: "POST", body: { name: "Status", type: "select", config: { options: [] } } }); renderWorkflow(); } }, "+ Add a Status property")));
  }
  const wf = workflow ? structuredClone(workflow) : (() => {
    const p = selects[0];
    const opts = p.config.options?.length ? p.config.options : [{ name: "Todo" }, { name: "In progress" }, { name: "Done" }];
    return { status_property_id: p.id, due_property_id: null, enforce: true, transitions: {},
      stages: opts.map((o, i) => ({ name: o.name, color: /^#[0-9a-f]{6}$/i.test(o.color || "") ? o.color : C.DEFAULT_PALETTE[i % 8], category: i === opts.length - 1 ? "done" : i === 0 ? "todo" : "active", wip_limit: null })) };
  })();

  const statusSel = h("select", { onchange: () => { wf.status_property_id = statusSel.value; } }, ...selects.map((p) => opt(p.id, p.name, p.id === wf.status_property_id)));
  const dueSel = h("select", { onchange: () => { wf.due_property_id = dueSel.value || null; } }, opt("", "— none —"), ...dates.map((p) => opt(p.id, p.name, p.id === wf.due_property_id)));
  const enforce = h("input", { type: "checkbox", checked: wf.enforce, onchange: () => { wf.enforce = enforce.checked; } });
  const stagesBox = h("div"), matrixBox = h("div", { class: "scroll" });

  function draw() {
    stagesBox.replaceChildren(h("div", { class: "stage small muted" }, h("span"), h("span", {}, "Stage"), h("span", {}, "Color"), h("span", {}, "Category"), h("span", {}, "WIP limit"), h("span")),
      ...wf.stages.map((st, i) => {
        const prevName = st.name;
        const name = h("input", { value: st.name, maxlength: "60", "aria-label": "Stage name", onchange: () => {
          const n = name.value.trim(); if (!n) return;
          st.name = n;
          // Keep transitions pointing at the renamed stage.
          if (wf.transitions[prevName]) { wf.transitions[n] = wf.transitions[prevName]; delete wf.transitions[prevName]; }
          for (const k of Object.keys(wf.transitions)) wf.transitions[k] = wf.transitions[k].map((t) => (t === prevName ? n : t));
          draw();
        } });
        const color = h("input", { type: "color", value: st.color, "aria-label": "Stage color", onchange: () => { st.color = color.value; } });
        const cat = h("select", { "aria-label": "Category", onchange: () => { st.category = cat.value; } }, ...[["todo", "To do"], ["active", "In progress"], ["done", "Done"]].map(([v, l]) => opt(v, l, v === st.category)));
        const wip = h("input", { type: "number", min: "1", value: st.wip_limit ?? "", placeholder: "∞", "aria-label": "WIP limit", onchange: () => { st.wip_limit = wip.value ? Number(wip.value) : null; } });
        return h("div", { class: "stage" },
          h("button", { class: "icon", type: "button", "aria-label": "Move up", disabled: i === 0, onclick: () => { [wf.stages[i - 1], wf.stages[i]] = [wf.stages[i], wf.stages[i - 1]]; draw(); } }, "↑"),
          name, color, cat, wip,
          h("button", { class: "icon", type: "button", "aria-label": `Remove ${st.name}`, onclick: () => {
            wf.stages.splice(i, 1); delete wf.transitions[st.name];
            for (const k of Object.keys(wf.transitions)) wf.transitions[k] = wf.transitions[k].filter((t) => t !== st.name);
            draw();
          } }, "✕"));
      }),
      h("button", { class: "ghost", type: "button", onclick: () => { wf.stages.push({ name: `Stage ${wf.stages.length + 1}`, color: C.DEFAULT_PALETTE[wf.stages.length % 8], category: "active", wip_limit: null }); draw(); } }, "+ Stage"));

    const names = wf.stages.map((x) => x.name);
    const table = h("table", { class: "matrix" },
      h("thead", {}, h("tr", {}, h("th", {}, "From ↓  To →"), ...names.map((n) => h("th", {}, n)), h("th", {}, "Any"))),
      h("tbody", {}, ...names.map((from) => {
        const rule = wf.transitions[from];
        const any = h("input", { type: "checkbox", checked: !rule, "aria-label": `${from} can move anywhere`, onchange: () => { if (any.checked) delete wf.transitions[from]; else wf.transitions[from] = names.filter((n) => n !== from); draw(); } });
        return h("tr", {}, h("td", {}, from), ...names.map((to) => {
          if (to === from) return h("td", { class: "muted" }, "·");
          const cb = h("input", { type: "checkbox", checked: !rule || rule.includes(to), disabled: !rule, "aria-label": `${from} to ${to}`, onchange: () => {
            const set = new Set(wf.transitions[from] || []); cb.checked ? set.add(to) : set.delete(to); wf.transitions[from] = [...set];
          } });
          return h("td", {}, cb);
        }), h("td", {}, any));
      })));
    matrixBox.replaceChildren(table);
  }
  draw();

  body.replaceChildren(h("div", { class: "grid" },
    h("div", { class: "card", style: "grid-column:span 2" },
      h("div", { class: "head" }, h("h3", {}, "Stages")),
      h("div", { class: "row" }, field("Status property", statusSel), field("Due date (for overdue)", dueSel)),
      stagesBox),
    h("div", { class: "card", style: "grid-column:span 2" },
      h("div", { class: "head" }, h("h3", {}, "Allowed moves")),
      h("p", { class: "muted small" }, "Untick “Any” to restrict where items in a stage may move next."),
      matrixBox,
      h("label", { class: "row small", style: "margin-top:14px" }, enforce, "Enforce stages, moves and WIP limits on the server"),
      h("div", { class: "row", style: "margin-top:14px" },
        h("button", { onclick: async () => {
          const { workflow: saved } = await api(`/databases/${id}/workflow`, { method: "PUT", body: wf });
          state.schemas.delete(id);
          toast(`Workflow saved (${saved.stages.length} stages)`);
          renderWorkflow();
        } }, "Save workflow"),
        workflow ? h("button", { class: "ghost", onclick: async () => {
          if (!(await dialog("Remove workflow?", h("p", {}, "Records keep their status; rules and progress tracking stop."), { submit: "Remove", danger: true }))) return;
          await api(`/databases/${id}/workflow`, { method: "DELETE" }); renderWorkflow();
        } }, "Remove") : null))));
}

// ── Data tab: editable grid + activity ───────────────────────────────────────
const PROP_TYPES = ["text", "number", "date", "checkbox", "select", "multi_select", "url", "email", "formula"];
async function renderData() {
  const id = $("dataDb").value;
  const box = $("dataTable");
  if (!id) { $("feed").replaceChildren(); return box.replaceChildren(h("div", { class: "empty-state" }, h("p", {}, "No databases yet."), h("button", { onclick: () => $("newDb").click() }, "+ Create a database"))); }
  const [s, { records }, { events }] = await Promise.all([schema(id, true), api(`/databases/${id}/records?compute=1`), api(`/databases/${id}/activity?limit=40`)]);
  const props = s.properties;
  const head = h("tr", {}, h("th", {}, "Title"), ...props.map((p) => h("th", {},
    h("span", { class: "row", style: "gap:4px;flex-wrap:nowrap" }, p.name, h("button", { class: "icon", "aria-label": `Options for ${p.name}`, onclick: (e) => propMenu(e.currentTarget, p) }, "▾")))), h("th"));
  const rows = records.map((r) => h("tr", {},
    h("td", {}, cell(r, { id: "title", type: "text" })),
    ...props.map((p) => h("td", {}, cell(r, p))),
    h("td", {}, h("button", { class: "icon", "aria-label": "Delete row", onclick: async () => { await api(`/records/${r.id}`, { method: "DELETE" }); renderData(); } }, "✕"))));
  const newTitle = h("input", { placeholder: `+ New ${noun().toLowerCase()}`, maxlength: "300", onkeydown: async (e) => {
    if (e.key !== "Enter" || !newTitle.value.trim()) return;
    await api(`/databases/${id}/records`, { method: "POST", body: { values: { title: newTitle.value.trim() } } });
    renderData();
  } });
  box.replaceChildren(h("table", { class: "data" }, h("thead", {}, head), h("tbody", {}, ...rows, h("tr", {}, h("td", { colspan: String(props.length + 2) }, newTitle)))));

  const nameOf = (pid) => (pid ? props.find((p) => p.id === pid)?.name || "a removed property" : "title");
  const show = (v) => (v == null ? "∅" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? "…" : String(v).slice(0, 40));
  $("feed").replaceChildren(...(events.length ? events.map((e) => h("li", {},
    h("b", {}, (e.actor || "someone").split("@")[0]), " ",
    e.kind === "created" ? "created a record" : e.kind === "deleted" ? "deleted a record" : `${e.kind === "stage_changed" ? "moved" : "set"} ${nameOf(e.property_id)}: ${show(e.from_value)} → ${show(e.to_value)}`,
    h("div", { class: "muted small" }, new Date(e.created_at).toLocaleString()))) : [h("li", { class: "muted" }, "No activity yet.")]));

  function cell(r, p) {
    const val = p.id === "title" ? r.values.title : r.computed?.[p.id] ?? r.values[p.id];
    const save = async (v) => {
      try { await api(`/records/${r.id}`, { method: "PATCH", body: { values: { [p.id]: v } } }); } catch { /* toast */ }
      renderData();
    };
    if (["formula", "rollup", "created_time", "updated_time"].includes(p.type)) return h("span", { class: "muted" }, val == null ? "" : C.fmt(Number(val)));
    if (p.type === "checkbox") { const cb = h("input", { type: "checkbox", checked: !!val, onchange: () => save(cb.checked) }); cb.style.width = "auto"; return cb; }
    if (p.type === "select") {
      const sel = h("select", { onchange: () => save(sel.value || null) }, opt("", ""), ...(p.config.options || []).map((o) => opt(o.name, o.name, o.name === val)));
      return sel;
    }
    if (p.type === "multi_select") {
      const input = h("input", { value: Array.isArray(val) ? val.join(", ") : "", placeholder: "a, b", onchange: () => save(input.value.split(",").map((x) => x.trim()).filter(Boolean)) });
      return input;
    }
    const input = h("input", { type: p.type === "number" ? "number" : p.type === "date" ? "date" : "text", value: val ?? "", onchange: () => save(p.type === "number" ? (input.value === "" ? null : Number(input.value)) : input.value) });
    return input;
  }
  function propMenu(anchor, p) {
    popup(anchor, [
      ["✎ Rename", async () => {
        const name = h("input", { value: p.name, maxlength: "120" });
        if (!(await dialog("Rename property", field("Name", name)))) return;
        await api(`/databases/properties/${p.id}`, { method: "PATCH", body: { name: name.value.trim() } }); renderData();
      }],
      ...(p.type === "select" || p.type === "multi_select" ? [["◐ Edit options", async () => {
        const area = h("textarea", { rows: "6", style: "width:100%" });
        area.value = (p.config.options || []).map((o) => `${o.name}${o.color ? ` ${o.color}` : ""}`).join("\n");
        if (!(await dialog("Options", h("div", {}, h("p", { class: "muted small" }, "One per line, optional #rrggbb colour after the name."), area)))) return;
        const options = area.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(.*?)\s+(#[0-9a-fA-F]{6})$/.exec(l); return m ? { name: m[1].slice(0, 60), color: m[2] } : { name: l.slice(0, 60) }; });
        await api(`/databases/properties/${p.id}`, { method: "PATCH", body: { config: { ...p.config, options } } }); renderData();
      }]] : []),
      ["✕ Delete property", async () => {
        if (!(await dialog("Delete property?", h("p", {}, `“${p.name}” and its values will be removed from every ${noun().toLowerCase()}.`), { submit: "Delete", danger: true }))) return;
        await api(`/databases/properties/${p.id}`, { method: "DELETE" }); renderData();
      }],
    ]);
  }
}

$("addProp").onclick = async () => {
  const id = $("dataDb").value; if (!id) return;
  const name = h("input", { maxlength: "120", placeholder: "e.g. Estimate" });
  const type = h("select", {}, ...PROP_TYPES.map((t) => opt(t, t.replace("_", " "))));
  const extra = h("input", { placeholder: "Options (a, b, c) or formula like [Price] * [Qty]" });
  if (!(await dialog("New property", h("div", {}, field("Name", name), field("Type", type), field("Options / formula", extra)), { submit: "Add" })) || !name.value.trim()) return;
  const config = type.value === "formula" ? { expression: extra.value } : ["select", "multi_select"].includes(type.value) ? { options: extra.value.split(",").map((x) => x.trim()).filter(Boolean).map((n, i) => ({ name: n, color: C.DEFAULT_PALETTE[i % 8] })) } : {};
  await api(`/databases/${id}/properties`, { method: "POST", body: { name: name.value.trim(), type: type.value, config } });
  renderData();
};
$("newDb").onclick = async () => {
  const name = h("input", { value: "Tasks", maxlength: "160" });
  if (!(await dialog("New database", field("Name", name), { submit: "Create" }))) return;
  const { database } = await api(`/workspaces/${state.wsId}/databases`, { method: "POST", body: { name: name.value.trim() || "Untitled" } });
  await loadDatabases();
  $("dataDb").value = database.id;
  renderData();
};
$("exportCsv").onclick = async () => { const id = $("dataDb").value; if (id) saveBlob(await api(`/databases/${id}/export.csv`, { blob: true })); };

// ── Customization ────────────────────────────────────────────────────────────
$("customizeBtn").onclick = async () => {
  const s = state.settings;
  const theme = h("select", {}, ...[["dark", "Dark"], ["light", "Light"], ["system", "Match system"]].map(([v, l]) => opt(v, l, v === (s.theme || "dark"))));
  const density = h("select", {}, ...[["comfortable", "Comfortable"], ["compact", "Compact"]].map(([v, l]) => opt(v, l, v === (s.density || "comfortable"))));
  const accent = h("input", { type: "color", value: s.accent || "#6d5efc" });
  const nounIn = h("input", { value: s.record_noun || "", placeholder: "Record (e.g. Task, Ticket, Lead)", maxlength: "30" });
  const pal = (s.chart_palette || C.DEFAULT_PALETTE).slice(0, 8);
  const palInputs = C.DEFAULT_PALETTE.map((d, i) => h("input", { type: "color", value: pal[i] || d, "aria-label": `Series ${i + 1} colour`, style: "padding:2px;width:40px;height:34px" }));
  const defaultDash = h("select", {}, opt("", "— first dashboard —"), ...state.dashboards.map((d) => opt(d.id, d.name, d.id === s.default_dashboard_id)));
  const navs = ["docs", "board"].map((k) => { const cb = h("input", { type: "checkbox", checked: s.nav?.[k] !== false }); return [k, cb]; });
  const resetPal = h("button", { type: "button", class: "ghost small", onclick: () => palInputs.forEach((p, i) => { p.value = C.DEFAULT_PALETTE[i]; }) }, "Reset palette");
  const ok = await dialog("Customize workspace", h("div", {},
    h("div", { class: "row" }, field("Theme", theme), field("Density", density), field("Accent", accent)),
    field(`What do you call a row?`, nounIn),
    field("Default dashboard", defaultDash),
    h("div", { class: "f" }, h("label", {}, "Chart palette (series order — keep it colour-blind safe)"), h("div", { class: "row" }, ...palInputs, resetPal)),
    h("div", { class: "f" }, h("label", {}, "Show in navigation"), h("div", { class: "row" }, ...navs.map(([k, cb]) => h("label", { class: "row small", style: "color:var(--text)" }, cb, k))))));
  if (!ok) return;
  const body = {
    theme: theme.value, density: density.value, accent: accent.value,
    chart_palette: palInputs.map((p) => p.value),
    nav: Object.fromEntries(navs.map(([k, cb]) => [k, cb.checked])),
    default_dashboard_id: defaultDash.value || null,
    record_noun: nounIn.value.trim() || null,
  };
  const { settings } = await api(`/workspaces/${state.wsId}/settings`, { method: "PATCH", body });
  state.settings = settings;
  applySettings();
  await showTab(state.tab);
  toast("Workspace customized");
};

// ── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  state.refresh = store.get("kinynx_refresh");
  if (!state.refresh) return $("auth").classList.remove("hidden");
  try { await refreshSession(); await boot(); } catch { $("auth").classList.remove("hidden"); }
})();
