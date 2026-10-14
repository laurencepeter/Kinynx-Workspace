// Kinynx admin console — reads /api/admin/* (requires deployment admin).
const $ = (id) => document.getElementById(id);
let token = null;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

$("loginBtn").onclick = async () => {
  try {
    const d = await api("/auth/login", { method: "POST", body: { email: $("email").value.trim(), password: $("password").value } });
    token = d.access_token;
    localStorage.setItem("kinynx_refresh", d.refresh_token);
    await boot();
  } catch (e) { alert(e.message); }
};

async function boot() {
  // Verify admin access up front.
  try {
    await api("/admin/stats");
  } catch {
    alert("This account is not a deployment admin.");
    return;
  }
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  await Promise.all([loadHealth(), loadStats(), loadLicense()]);
}

async function loadHealth() {
  const h = await api("/admin/health");
  const wrap = $("health"); wrap.innerHTML = "";
  for (const [k, v] of Object.entries(h.checks)) {
    const el = document.createElement("span");
    el.className = "pill " + (v === "down" ? "down" : "ok");
    el.textContent = `${v === "down" ? "✕" : "✓"} ${k}`;
    wrap.appendChild(el);
  }
  $("drivers").innerHTML = `<span class="pill">storage: ${h.storage_driver}</span><span class="pill">ai: ${h.ai}</span><span class="pill">status: ${h.status}</span>`;
}

async function loadStats() {
  const s = await api("/admin/stats");
  const g = $("stats"); g.innerHTML = "";
  const tile = (n, l) => { const d = document.createElement("div"); d.className = "stat"; d.innerHTML = `<div class="n">${n}</div><div class="l">${l}</div>`; return d; };
  for (const [k, v] of Object.entries(s.counts)) g.appendChild(tile(v, k));
  g.appendChild(tile(fmtBytes(s.storage_bytes), "storage used"));
  $("edition").textContent = `${s.edition} Edition`;
}

async function loadLicense() {
  const l = await api("/admin/license");
  $("licenseInfo").textContent = `${l.edition} Edition · plan: ${l.plan} · SSO: ${l.features.sso_saml ? "on" : "off"} · audit: ${l.features.audit_logs ? "on" : "off"}`;
}

$("uploadLicense").onclick = async () => {
  try {
    const body = JSON.parse($("licenseText").value);
    const r = await api("/admin/license", { method: "POST", body });
    $("licenseMsg").textContent = `Activated: ${r.edition} (${r.plan})`;
    await Promise.all([loadLicense(), loadStats()]);
  } catch (e) { $("licenseMsg").textContent = e.message; }
};

function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

(async function init() {
  const refresh = localStorage.getItem("kinynx_refresh");
  if (!refresh) return;
  try {
    const d = await api("/auth/refresh", { method: "POST", body: { refresh_token: refresh } });
    token = d.access_token;
    localStorage.setItem("kinynx_refresh", d.refresh_token);
    await boot();
  } catch { /* stay on login */ }
})();
