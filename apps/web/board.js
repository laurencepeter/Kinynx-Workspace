// Kinynx Kanban board + live report — vanilla JS against the same API.
const $ = (id) => document.getElementById(id);
const state = { token: null, refresh: null, wsId: null, dbId: null, statusPropId: null, progressPropId: null };

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

$("loginBtn").onclick = async () => {
  try {
    const data = await api("/auth/login", { method: "POST", body: { email: $("email").value.trim(), password: $("password").value } });
    state.token = data.access_token; state.refresh = data.refresh_token;
    localStorage.setItem("kinynx_refresh", data.refresh_token);
    await boot();
  } catch (e) { alert(e.message); }
};

async function boot() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  const { organizations } = await api("/organizations");
  const wsSel = $("workspace"); wsSel.innerHTML = "";
  for (const o of organizations) {
    const { workspaces } = await api(`/organizations/${o.id}/workspaces`);
    for (const w of workspaces) {
      const opt = document.createElement("option");
      opt.value = w.id; opt.textContent = `${o.name} / ${w.name}`;
      wsSel.appendChild(opt);
    }
  }
  if (wsSel.value) { state.wsId = wsSel.value; await loadDatabases(); }
}

$("workspace").onchange = async () => { state.wsId = $("workspace").value; await loadDatabases(); };
$("database").onchange = async () => { state.dbId = $("database").value; await loadBoard(); };

$("newDb").onclick = async () => {
  const name = prompt("Database name", "Tasks"); if (!name) return;
  const { database } = await api(`/workspaces/${state.wsId}/databases`, { method: "POST", body: { name } });
  // Seed a colour-coded Status and a Progress property so the board works immediately.
  await api(`/databases/${database.id}/properties`, { method: "POST", body: { name: "Status", type: "select", config: { options: [
    { name: "Todo", color: "#f87171" }, { name: "In Progress", color: "#fbbf24" }, { name: "Done", color: "#34d399" },
  ] } } });
  await api(`/databases/${database.id}/properties`, { method: "POST", body: { name: "Progress", type: "number", config: {} } });
  await loadDatabases(); $("database").value = database.id; state.dbId = database.id; await loadBoard();
};

async function loadDatabases() {
  const { databases } = await api(`/workspaces/${state.wsId}/databases`);
  const sel = $("database"); sel.innerHTML = "";
  databases.forEach((d) => { const o = document.createElement("option"); o.value = d.id; o.textContent = d.name; sel.appendChild(o); });
  if (sel.value) { state.dbId = sel.value; await loadBoard(); }
  else { $("board").innerHTML = '<p class="muted">Create a database to start.</p>'; $("report").innerHTML = ""; }
}

$("addStatus").onclick = async () => {
  if (!state.statusPropId) return;
  const name = $("statusName").value.trim(); if (!name) return;
  const { database, properties } = await api(`/databases/${state.dbId}`);
  void database;
  const prop = properties.find((p) => p.id === state.statusPropId);
  const options = [...(prop.config.options || []), { name, color: $("statusColor").value }];
  await api(`/databases/properties/${state.statusPropId}`, { method: "PATCH", body: { config: { ...prop.config, options } } });
  $("statusName").value = ""; await loadBoard();
};

$("addCard").onclick = async () => {
  const title = $("cardTitle").value.trim(); if (!title || !state.dbId) return;
  const values = { title };
  await api(`/databases/${state.dbId}/records`, { method: "POST", body: { values } });
  $("cardTitle").value = ""; await loadBoard();
};

async function loadBoard() {
  const { properties } = await api(`/databases/${state.dbId}`);
  const status = properties.find((p) => p.type === "select");
  const progress = properties.find((p) => p.type === "number");
  state.statusPropId = status?.id || null;
  state.progressPropId = progress?.id || null;
  const options = status?.config.options || [];

  const { records } = await api(`/databases/${state.dbId}/records?compute=1`);

  // Report
  renderReport(records, status, progress, options);

  // Board columns = status options + an "Unset" column.
  const cols = [...options, { name: "—", color: "#475569" }];
  const board = $("board"); board.innerHTML = "";
  for (const opt of cols) {
    const inCol = records.filter((r) => (r.values[status?.id] ?? "—") === opt.name);
    const col = document.createElement("div"); col.className = "col";
    col.innerHTML = `<h3><span class="dot" style="background:${opt.color}"></span>${opt.name}<span class="count">${inCol.length}</span></h3>`;
    for (const rec of inCol) {
      const card = document.createElement("div"); card.className = "card";
      const title = rec.values.title || "(untitled)";
      const prog = state.progressPropId != null ? Number(rec.values[state.progressPropId] ?? 0) : null;
      card.innerHTML = `<div class="title">${escapeHtml(String(title))}</div>` +
        (prog != null ? `<div class="progress"><div style="width:${Math.max(0, Math.min(100, prog))}%"></div></div>` : "");
      if (status) {
        const sel = document.createElement("select");
        for (const o of options) { const op = document.createElement("option"); op.value = o.name; op.textContent = o.name; if ((rec.values[status.id]) === o.name) op.selected = true; sel.appendChild(op); }
        // The server enforces the workflow (allowed moves, WIP limits) — surface its answer.
        sel.onchange = async () => {
          try { await api(`/records/${rec.id}`, { method: "PATCH", body: { values: { [status.id]: sel.value } } }); } catch (e) { alert(e.message); }
          await loadBoard();
        };
        card.appendChild(sel);
      }
      col.appendChild(card);
    }
    board.appendChild(col);
  }
}

function renderReport(records, status, progress, options) {
  const rep = $("report"); rep.innerHTML = "";
  const total = records.length;
  const tile = (n, l) => { const d = document.createElement("div"); d.className = "stat"; d.innerHTML = `<div class="n">${n}</div><div class="l">${l}</div>`; return d; };
  rep.appendChild(tile(total, "Total"));
  if (status) for (const o of options) {
    const c = records.filter((r) => r.values[status.id] === o.name).length;
    const d = tile(c, o.name); d.style.borderColor = o.color; rep.appendChild(d);
  }
  if (progress) {
    const nums = records.map((r) => Number(r.values[progress.id])).filter((n) => !Number.isNaN(n));
    const avg = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
    const d = tile(`${avg}%`, "Avg progress"); d.innerHTML += `<div class="progress"><div style="width:${avg}%"></div></div>`; rep.appendChild(d);
  }
}

function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

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
