// Kinynx charts — tiny dependency-free SVG charts for dashboards & progress.
// SECURITY: every label/value is set via textContent; colours are accepted only
// as #rrggbb, so chart data can never inject markup or CSS.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  // Validated categorical order (dark surface). Fixed order, never cycled past 8.
  const DEFAULT_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const HEX = /^#[0-9a-fA-F]{6}$/;
  let palette = DEFAULT_PALETTE;

  const svg = (tag, attrs = {}) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  const html = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  };
  const safe = (c, i) => (typeof c === "string" && HEX.test(c) ? c : palette[i % palette.length]);
  const fmt = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
    if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
    return Number.isInteger(n) ? n.toLocaleString() : (+n.toFixed(2)).toLocaleString();
  };
  const niceMax = (m) => {
    if (m <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(m));
    return [1, 2, 2.5, 5, 10].map((x) => x * p).find((x) => x >= m);
  };

  // ── Shared tooltip ────────────────────────────────────────────────────────
  let tip;
  function tooltip(evt, title, rows) {
    if (!tip) { tip = html("div", "kx-tip"); tip.setAttribute("role", "status"); document.body.append(tip); }
    tip.replaceChildren(html("div", "kx-tip-t", title));
    for (const [color, name, value] of rows) {
      const r = html("div", "kx-tip-r");
      const sw = html("span", "kx-sw"); sw.style.background = color;
      r.append(sw, html("span", "", name), html("b", "", fmt(value)));
      tip.append(r);
    }
    tip.style.display = "block";
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, evt.clientX + 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${evt.clientY + 14}px`;
  }
  const hideTip = () => { if (tip) tip.style.display = "none"; };

  function legend(series) {
    if (series.length < 2) return null;
    const l = html("div", "kx-legend");
    series.slice(0, 8).forEach((s, i) => {
      const it = html("span", "kx-li");
      const sw = html("span", "kx-sw"); sw.style.background = safe(s.color, i);
      it.append(sw, document.createTextNode(s.name));
      l.append(it);
    });
    return l;
  }

  /** Fold series beyond 8 into "Other" so hues are never generated or cycled. */
  function capSeries(series) {
    if (series.length <= 8) return series;
    const keep = series.slice(0, 7);
    const rest = series.slice(7);
    keep.push({ name: "Other", color: "#8a8a85", data: rest[0].data.map((_, i) => rest.reduce((a, s) => a + (s.data[i] || 0), 0)) });
    return keep;
  }

  // Draw at the container's real pixel width so text stays 12px at any size.
  const width = (el) => Math.max(280, Math.round(el.clientWidth || 520));
  const shortLabel = (l) => (/^\d{4}-\d{2}-\d{2}$/.test(String(l)) ? String(l).slice(5) : String(l).slice(0, 10));

  function empty(el, msg = "No data yet") { el.replaceChildren(html("div", "kx-empty", msg)); }

  // ── Horizontal bars (ranked categories; stacked when split) ───────────────
  function bar(el, data) {
    const series = capSeries(data.series);
    const labels = data.labels;
    if (!labels.length) return empty(el);
    const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.data[i] || 0), 0));
    const max = Math.max(1, ...totals);
    const rowH = 30, labelW = 120, valW = 48, W = width(el);
    const plotW = W - labelW - valW;
    const H = labels.length * rowH;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": "Bar chart" });
    root.append(svg("line", { x1: labelW, y1: 0, x2: labelW, y2: H, class: "kx-axis" }));
    labels.forEach((label, i) => {
      const y = i * rowH;
      const t = svg("text", { x: labelW - 8, y: y + 19, "text-anchor": "end", class: "kx-lbl" });
      t.textContent = String(label).length > 18 ? `${String(label).slice(0, 17)}…` : label;
      root.append(t);
      let x = labelW;
      series.forEach((s, si) => {
        const v = Math.max(0, s.data[i] || 0);
        const w = (v / max) * plotW;
        if (w <= 0) return;
        const color = safe(s.colors?.[i] ?? s.color, si);
        const r = svg("rect", { x, y: y + 6, width: Math.max(2, w - 2), height: 18, rx: 4, fill: color, class: "kx-mark" });
        r.addEventListener("mousemove", (e) => tooltip(e, label, series.map((ss, k) => [safe(ss.colors?.[i] ?? ss.color, k), ss.name, ss.data[i] || 0])));
        r.addEventListener("mouseleave", hideTip);
        root.append(r);
        x += w;
      });
      const vt = svg("text", { x: x + 6, y: y + 19, class: "kx-val" });
      vt.textContent = fmt(totals[i]);
      root.append(vt);
    });
    el.replaceChildren(root);
    const lg = legend(series); if (lg) el.append(lg);
  }

  // ── Columns (ordered categories / time; stacked when split) ───────────────
  function column(el, data) {
    const series = capSeries(data.series);
    const labels = data.labels;
    if (!labels.length) return empty(el);
    const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.data[i] || 0), 0));
    const top = niceMax(Math.max(...totals));
    const W = width(el), H = 220, L = 36, B = 28, T = 10;
    const plotH = H - B - T, band = (W - L) / labels.length, bw = Math.min(24, band * 0.7);
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": "Column chart" });
    grid(root, top, L, W, T, plotH);
    labels.forEach((label, i) => {
      const cx = L + band * i + band / 2;
      let y = T + plotH;
      series.forEach((s, si) => {
        const v = Math.max(0, s.data[i] || 0);
        const h = (v / top) * plotH;
        if (h <= 0) return;
        const r = svg("rect", { x: cx - bw / 2, y: y - h, width: bw, height: Math.max(1, h - (si < series.length - 1 ? 2 : 0)), rx: si === series.length - 1 ? 4 : 0, fill: safe(s.colors?.[i] ?? s.color, si), class: "kx-mark" });
        r.addEventListener("mousemove", (e) => tooltip(e, label, series.map((ss, k) => [safe(ss.colors?.[i] ?? ss.color, k), ss.name, ss.data[i] || 0])));
        r.addEventListener("mouseleave", hideTip);
        root.append(r);
        y -= h;
      });
      const every = Math.ceil(labels.length / Math.max(2, Math.floor((W - L) / 64)));
      if (i % every === 0) {
        const t = svg("text", { x: cx, y: H - 8, "text-anchor": "middle", class: "kx-lbl" });
        t.textContent = shortLabel(label);
        root.append(t);
      }
    });
    el.replaceChildren(root);
    const lg = legend(series); if (lg) el.append(lg);
  }

  function grid(root, top, L, W, T, plotH) {
    for (let k = 0; k <= 4; k++) {
      const y = T + plotH - (plotH * k) / 4;
      root.append(svg("line", { x1: L, y1: y, x2: W, y2: y, class: k ? "kx-grid" : "kx-axis" }));
      const t = svg("text", { x: L - 6, y: y + 4, "text-anchor": "end", class: "kx-lbl" });
      t.textContent = fmt((top * k) / 4);
      root.append(t);
    }
  }

  // ── Line / area with crosshair tooltip ────────────────────────────────────
  function line(el, data, { area = false } = {}) {
    const series = capSeries(data.series);
    const labels = data.labels;
    if (!labels.length) return empty(el);
    const top = niceMax(Math.max(0, ...series.flatMap((s) => s.data)));
    const W = width(el), H = 220, L = 36, B = 28, T = 10, R = 10;
    const plotH = H - B - T, plotW = W - L - R;
    const xAt = (i) => L + (labels.length === 1 ? plotW / 2 : (plotW * i) / (labels.length - 1));
    const yAt = (v) => T + plotH - (Math.max(0, v) / top) * plotH;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": "Line chart" });
    grid(root, top, L, W - R, T, plotH);
    series.forEach((s, si) => {
      const c = safe(s.color, si);
      const pts = s.data.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
      if (area) root.append(svg("polygon", { points: `${xAt(0)},${T + plotH} ${pts.join(" ")} ${xAt(s.data.length - 1)},${T + plotH}`, fill: c, "fill-opacity": 0.1 }));
      root.append(svg("polyline", { points: pts.join(" "), fill: "none", stroke: c, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const li = s.data.length - 1;
      root.append(svg("circle", { cx: xAt(li), cy: yAt(s.data[li]), r: 4, fill: c, class: "kx-dot" }));
    });
    const step = Math.ceil(labels.length / Math.max(2, Math.floor(plotW / 64)));
    labels.forEach((label, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      const t = svg("text", { x: xAt(i), y: H - 8, "text-anchor": "middle", class: "kx-lbl" });
      t.textContent = shortLabel(label);
      root.append(t);
    });
    const cross = svg("line", { x1: 0, y1: T, x2: 0, y2: T + plotH, class: "kx-cross", visibility: "hidden" });
    root.append(cross);
    const hit = svg("rect", { x: L, y: T, width: plotW, height: plotH, fill: "transparent" });
    hit.addEventListener("mousemove", (e) => {
      const box = root.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(labels.length - 1, Math.round(((px - L) / plotW) * (labels.length - 1))));
      cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i)); cross.setAttribute("visibility", "visible");
      tooltip(e, labels[i], series.map((s, k) => [safe(s.color, k), s.name, s.data[i] || 0]));
    });
    hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
    root.append(hit);
    el.replaceChildren(root);
    const lg = legend(series); if (lg) el.append(lg);
  }

  // ── Donut (parts of a whole, ≤ 8 slices) ──────────────────────────────────
  function donut(el, data) {
    const s = data.series[0];
    if (!s || !data.labels.length) return empty(el);
    let items = data.labels.map((l, i) => ({ name: l, value: Math.max(0, s.data[i] || 0), color: s.colors?.[i] }));
    if (items.length > 8) {
      const rest = items.slice(7).reduce((a, b) => a + b.value, 0);
      items = [...items.slice(0, 7), { name: "Other", value: rest, color: "#8a8a85" }];
    }
    const total = items.reduce((a, b) => a + b.value, 0);
    if (!total) return empty(el);
    const R = 80, r = 52, C = 100;
    const root = svg("svg", { viewBox: "0 0 200 200", width: "180", height: "180", role: "img", "aria-label": "Donut chart" });
    let a0 = -Math.PI / 2;
    items.forEach((it, i) => {
      if (!it.value) return;
      const a1 = a0 + (it.value / total) * Math.PI * 2;
      const gap = items.filter((x) => x.value).length > 1 ? 0.012 : 0;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${C + rad * Math.cos(ang)} ${C + rad * Math.sin(ang)}`;
      const d = it.value === total
        ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} L ${C - 0.01} ${C - r} A ${r} ${r} 0 1 0 ${C} ${C - r} Z`
        : `M ${p(R, a0 + gap)} A ${R} ${R} 0 ${large} 1 ${p(R, a1 - gap)} L ${p(r, a1 - gap)} A ${r} ${r} 0 ${large} 0 ${p(r, a0 + gap)} Z`;
      const path = svg("path", { d, fill: safe(it.color, i), class: "kx-mark" });
      path.addEventListener("mousemove", (e) => tooltip(e, it.name, [[safe(it.color, i), `${Math.round((it.value / total) * 100)}%`, it.value]]));
      path.addEventListener("mouseleave", hideTip);
      root.append(path);
      a0 = a1;
    });
    const t = svg("text", { x: C, y: C + 6, "text-anchor": "middle", class: "kx-hero-s" });
    t.textContent = fmt(total);
    root.append(t);
    const wrap = html("div", "kx-donut");
    const lg = html("div", "kx-legend kx-legend-v");
    items.forEach((it, i) => {
      const row = html("span", "kx-li");
      const sw = html("span", "kx-sw"); sw.style.background = safe(it.color, i);
      row.append(sw, document.createTextNode(`${it.name}`), html("b", "", fmt(it.value)));
      lg.append(row);
    });
    wrap.append(root, lg);
    el.replaceChildren(wrap);
  }

  function number(el, data, { label = "" } = {}) {
    const v = data.series[0]?.data[0] ?? 0;
    const box = html("div", "kx-number");
    box.append(html("div", "kx-hero", fmt(v)));
    if (label) box.append(html("div", "kx-sub", label));
    box.append(html("div", "kx-sub", `${data.total} records`));
    el.replaceChildren(box);
  }

  function table(el, data) {
    if (!data.labels.length) return empty(el);
    const t = html("table", "kx-table");
    const hr = html("tr");
    hr.append(html("th", "", "Group"), ...data.series.map((s) => html("th", "num", s.name)));
    const thead = html("thead"); thead.append(hr);
    const tb = html("tbody");
    data.labels.forEach((l, i) => {
      const tr = html("tr");
      tr.append(html("td", "", l), ...data.series.map((s) => html("td", "num", fmt(s.data[i] || 0))));
      tb.append(tr);
    });
    t.append(thead, tb);
    el.replaceChildren(t);
  }

  /** Meter: fill + track of one ramp; marks a WIP limit when given. */
  function meter(pct, { limit = null, value = null } = {}) {
    const m = html("div", "kx-meter");
    const f = html("div", "kx-fill");
    f.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (limit !== null && value !== null && value > limit) f.classList.add("over");
    m.append(f);
    return m;
  }

  window.KinynxCharts = {
    bar, column, line, donut, number, table, meter, fmt,
    area: (el, d) => line(el, d, { area: true }),
    stacked: column,
    setPalette(p) { palette = Array.isArray(p) && p.length && p.every((c) => HEX.test(c)) ? p : DEFAULT_PALETTE; },
    DEFAULT_PALETTE,
  };
})();
