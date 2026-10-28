/**
 * Report rendering for dashboards: Markdown, CSV and a self-contained HTML
 * document with server-drawn SVG bar charts. Every user-supplied string is
 * escaped; the HTML is served as an attachment under a no-script CSP.
 */
import type { ChartResult } from "./query.js";
import { csvCell } from "./query.js";

export interface ReportWidget {
  title: string;
  type: string;
  database: string;
  chart?: ChartResult;
  progress?: { total: number; completion_pct: number; throughput_per_week: number; lead_time_days: number | null; overdue: number; forecast_done_date: string | null; by_stage: Array<{ name: string; count: number; color: string }> };
  error?: string;
}

export interface ReportInput {
  title: string;
  description: string;
  generatedAt: Date;
  generatedBy: string;
  widgets: ReportWidget[];
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const mdEsc = (s: unknown) => String(s ?? "").replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1").replace(/\n/g, " ");
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** Rows of [label, series1, series2, …] for tabular output. */
function rows(c: ChartResult): Array<Array<string | number>> {
  return c.labels.map((l, i) => [l, ...c.series.map((s) => s.data[i] ?? 0)]);
}

export function renderMarkdown(r: ReportInput): string {
  const out = [`# ${mdEsc(r.title)}`, "", r.description ? `${mdEsc(r.description)}\n` : "", `_Generated ${r.generatedAt.toISOString()} by ${mdEsc(r.generatedBy)}_`, ""];
  for (const w of r.widgets) {
    out.push(`## ${mdEsc(w.title)}`, "", `Source: ${mdEsc(w.database)}`, "");
    if (w.error) { out.push(`> ${mdEsc(w.error)}`, ""); continue; }
    if (w.progress) {
      const p = w.progress;
      out.push(`- **Completion:** ${p.completion_pct}% of ${p.total}`, `- **Throughput:** ${p.throughput_per_week}/week`, `- **Lead time:** ${p.lead_time_days ?? "—"} days`, `- **Overdue:** ${p.overdue}`, `- **Forecast done:** ${p.forecast_done_date ?? "—"}`, "");
      out.push("| Stage | Count |", "| --- | ---: |", ...p.by_stage.map((s) => `| ${mdEsc(s.name)} | ${s.count} |`), "");
      continue;
    }
    if (w.chart) {
      const c = w.chart;
      out.push(`| ${["Group", ...c.series.map((s) => s.name)].map(mdEsc).join(" | ")} |`, `| --- |${c.series.map(() => " ---: |").join("")}`);
      for (const row of rows(c)) out.push(`| ${row.map((v, i) => (i === 0 ? mdEsc(v) : fmt(Number(v)))).join(" | ")} |`);
      out.push("", `_${c.total} records matched._`, "");
    }
  }
  return out.join("\n");
}

export function renderCsv(r: ReportInput): string {
  const lines = [["widget", "source", "group", "series", "value"].join(",")];
  for (const w of r.widgets) {
    if (w.chart) for (const s of w.chart.series) w.chart.labels.forEach((l, i) => lines.push([w.title, w.database, l, s.name, s.data[i] ?? 0].map(csvCell).join(",")));
    if (w.progress) for (const st of w.progress.by_stage) lines.push([w.title, w.database, st.name, "count", st.count].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Horizontal bar chart (one bar per label, stacked when there are several series). */
function svgBars(c: ChartResult): string {
  const n = Math.min(c.labels.length, 25);
  if (n === 0) return `<p class="muted">No data.</p>`;
  const totals = c.labels.slice(0, n).map((_, i) => c.series.reduce((a, s) => a + Math.max(0, s.data[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const rowH = 28, labelW = 160, plotW = 420, h = n * rowH + 8;
  const bars: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = 4 + i * rowH;
    let x = labelW;
    c.series.forEach((s, si) => {
      const v = Math.max(0, s.data[i] ?? 0);
      const w = (v / max) * plotW;
      if (w <= 0) return;
      const raw = s.colors?.[i] ?? s.color ?? PALETTE[si % PALETTE.length]!;
      const color = SAFE_COLOR.test(raw) ? raw : PALETTE[si % PALETTE.length]!;
      bars.push(`<rect x="${x.toFixed(1)}" y="${y + 4}" width="${Math.max(1, w - 2).toFixed(1)}" height="18" rx="4" fill="${color}"><title>${esc(c.labels[i])} · ${esc(s.name)}: ${fmt(v)}</title></rect>`);
      x += w;
    });
    bars.push(`<text x="${labelW - 8}" y="${y + 17}" text-anchor="end" class="lbl">${esc(String(c.labels[i]).slice(0, 24))}</text>`);
    bars.push(`<text x="${x + 6}" y="${y + 17}" class="val">${fmt(totals[i]!)}</text>`);
  }
  return `<svg viewBox="0 0 ${labelW + plotW + 60} ${h}" width="100%" role="img" aria-label="Bar chart"><line x1="${labelW}" y1="0" x2="${labelW}" y2="${h}" class="axis"/>${bars.join("")}</svg>`;
}

function htmlTable(c: ChartResult): string {
  const head = ["Group", ...c.series.map((s) => s.name)].map((x) => `<th>${esc(x)}</th>`).join("");
  const body = rows(c).map((r) => `<tr>${r.map((v, i) => (i === 0 ? `<td>${esc(v)}</td>` : `<td class="num">${fmt(Number(v))}</td>`)).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderHtml(r: ReportInput): string {
  const sections = r.widgets.map((w) => {
    let inner = "";
    if (w.error) inner = `<p class="muted">${esc(w.error)}</p>`;
    else if (w.progress) {
      const p = w.progress;
      const tiles = [["Completion", `${p.completion_pct}%`], ["Total", fmt(p.total)], ["Throughput / wk", fmt(p.throughput_per_week)], ["Lead time (days)", p.lead_time_days ?? "—"], ["Overdue", fmt(p.overdue)], ["Forecast done", p.forecast_done_date ?? "—"]]
        .map(([l, v]) => `<div class="tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join("");
      const chart: ChartResult = { labels: p.by_stage.map((s) => s.name), series: [{ name: "Count", color: null, colors: p.by_stage.map((s) => s.color), data: p.by_stage.map((s) => s.count) }], total: p.total, metric: { agg: "count", property: null } };
      inner = `<div class="tiles">${tiles}</div>${svgBars(chart)}`;
    } else if (w.chart) {
      inner = w.type === "number"
        ? `<div class="hero">${fmt(w.chart.series[0]?.data[0] ?? 0)}</div>`
        : `${w.type === "table" ? "" : svgBars(w.chart)}${htmlTable(w.chart)}<p class="muted">${w.chart.total} records matched.</p>`;
    }
    return `<section><h2>${esc(w.title)}</h2><p class="muted">Source: ${esc(w.database)}</p>${inner}</section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title>
<style>
:root{--bg:#fcfcfb;--fg:#0b0b0b;--muted:#52514e;--line:#e4e3df;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#f0efec;--muted:#c3c2b7;--line:#2e2d2a;--card:#1a1a19}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:0 0 2px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0;break-inside:avoid}
.muted{color:var(--muted);font-size:13px;margin:0 0 10px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{border:1px solid var(--line);border-radius:10px;padding:10px}.tile .l{font-size:12px;color:var(--muted)}.tile .v{font-size:20px;font-weight:600}
.hero{font-size:48px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}td.num{text-align:right;font-variant-numeric:tabular-nums}
svg .lbl,svg .val{font-size:12px;fill:var(--muted)}svg .axis{stroke:var(--line)}
</style></head><body><main><h1>${esc(r.title)}</h1>${r.description ? `<p>${esc(r.description)}</p>` : ""}
<p class="muted">Generated ${esc(r.generatedAt.toISOString())} by ${esc(r.generatedBy)}</p>${sections.join("")}</main></body></html>`;
}
