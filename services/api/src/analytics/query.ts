/**
 * Chart/report query engine over database records. Pure (no I/O) so it is
 * unit-testable: callers load records + properties (after authorization) and
 * this module filters, groups, buckets and aggregates them into chart series.
 *
 * Shapes are validated with Zod at the edge; nothing here evaluates user code.
 */
import { z } from "zod";
import { aggregate } from "../database/compute.js";

/** Pseudo-properties every record has. */
export const SYSTEM_FIELDS = ["created_at", "updated_at"] as const;

const fieldRef = z.union([z.string().uuid(), z.enum(SYSTEM_FIELDS), z.literal("title")]);

export const FilterSchema = z.object({
  property: fieldRef,
  op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty", "in", "within_days"]),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.union([z.string().max(500), z.number()])).max(100)]).optional(),
});

export const ChartQuerySchema = z.object({
  filters: z.array(FilterSchema).max(20).default([]),
  match: z.enum(["all", "any"]).default("all"),
  group_by: fieldRef.optional(),
  bucket: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
  split_by: fieldRef.optional(),
  metric: z
    .object({ agg: z.enum(["count", "sum", "avg", "min", "max"]).default("count"), property: fieldRef.optional() })
    .default({ agg: "count" }),
  cumulative: z.boolean().default(false),
  sort: z.enum(["natural", "label", "value_desc", "value_asc"]).default("natural"),
  limit: z.number().int().min(1).max(200).default(50),
});

export type Filter = z.infer<typeof FilterSchema>;
export type ChartQuery = z.infer<typeof ChartQuerySchema>;

export interface PropertyInfo {
  id: string;
  name: string;
  type: string;
  config: { options?: Array<{ name: string; color?: string }> } & Record<string, unknown>;
}

export interface RecordInput {
  id: string;
  values: Record<string, unknown>;
  computed?: Record<string, number>;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ChartResult {
  labels: string[];
  series: Array<{ name: string; color: string | null; data: number[]; colors?: Array<string | null> }>;
  total: number; // records matched by the filters
  metric: { agg: string; property: string | null };
}

const EMPTY = "(empty)";

/** Raw value of a field on a record (computed values win for formula/rollup). */
export function fieldValue(rec: RecordInput, field: string): unknown {
  if (field === "created_at") return rec.created_at;
  if (field === "updated_at") return rec.updated_at;
  if (rec.computed && rec.computed[field] !== undefined) return rec.computed[field];
  return rec.values[field];
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function toTime(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

function compare(a: unknown, b: unknown): number {
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "") return na - nb;
  const ta = toTime(a), tb = toTime(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a).localeCompare(String(b));
}

export function matches(rec: RecordInput, f: Filter, now = Date.now()): boolean {
  const v = fieldValue(rec, f.property);
  const vals = Array.isArray(v) ? v.map(String) : [String(v ?? "")];
  switch (f.op) {
    case "empty": return isEmpty(v);
    case "not_empty": return !isEmpty(v);
    case "eq": return !isEmpty(v) && vals.includes(String(f.value));
    case "neq": return !vals.includes(String(f.value));
    case "contains": return vals.some((s) => s.toLowerCase().includes(String(f.value ?? "").toLowerCase()));
    case "in": return Array.isArray(f.value) && f.value.some((x) => vals.includes(String(x)));
    case "gt": return !isEmpty(v) && compare(v, f.value) > 0;
    case "gte": return !isEmpty(v) && compare(v, f.value) >= 0;
    case "lt": return !isEmpty(v) && compare(v, f.value) < 0;
    case "lte": return !isEmpty(v) && compare(v, f.value) <= 0;
    case "within_days": {
      const t = toTime(v);
      const days = Number(f.value);
      return !Number.isNaN(t) && Number.isFinite(days) && Math.abs(now - t) <= days * 86_400_000;
    }
  }
}

export function applyFilters(records: RecordInput[], filters: Filter[], match: "all" | "any" = "all", now = Date.now()): RecordInput[] {
  if (filters.length === 0) return records;
  return records.filter((r) => (match === "all" ? filters.every((f) => matches(r, f, now)) : filters.some((f) => matches(r, f, now))));
}

/** ISO-ish bucket key for a timestamp (UTC). Weeks start Monday. */
export function bucketKey(t: number, bucket: NonNullable<ChartQuery["bucket"]>): string {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (bucket) {
    case "day": return d.toISOString().slice(0, 10);
    case "week": {
      const day = (d.getUTCDay() + 6) % 7; // Monday = 0
      return new Date(Date.UTC(y, m, d.getUTCDate() - day)).toISOString().slice(0, 10);
    }
    case "month": return `${y}-${String(m + 1).padStart(2, "0")}`;
    case "quarter": return `${y}-Q${Math.floor(m / 3) + 1}`;
    case "year": return String(y);
  }
}

function isDateField(field: string, props: Map<string, PropertyInfo>): boolean {
  if ((SYSTEM_FIELDS as readonly string[]).includes(field)) return true;
  const t = props.get(field)?.type;
  return t === "date" || t === "created_time" || t === "updated_time";
}

/** Group keys a record contributes to (multi-select contributes to several). */
function keysFor(rec: RecordInput, field: string, props: Map<string, PropertyInfo>, bucket?: ChartQuery["bucket"]): string[] {
  const v = fieldValue(rec, field);
  if (isEmpty(v)) return [EMPTY];
  if (isDateField(field, props)) {
    const t = toTime(v);
    return Number.isNaN(t) ? [EMPTY] : [bucketKey(t, bucket ?? "day")];
  }
  if (props.get(field)?.type === "checkbox") return [v === true || v === "true" ? "Checked" : "Unchecked"];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function optionOrder(field: string | undefined, props: Map<string, PropertyInfo>): string[] {
  return field ? (props.get(field)?.config.options ?? []).map((o) => o.name) : [];
}
function colorOf(field: string | undefined, name: string, props: Map<string, PropertyInfo>): string | null {
  return field ? (props.get(field)?.config.options?.find((o) => o.name === name)?.color ?? null) : null;
}

/** Run a chart query. `properties` must be the database's own properties. */
export function runChartQuery(records: RecordInput[], properties: PropertyInfo[], q: ChartQuery, now = Date.now()): ChartResult {
  const props = new Map(properties.map((p) => [p.id, p]));
  const rows = applyFilters(records, q.filters, q.match, now);
  const metricProp = q.metric.property ?? null;
  const value = (r: RecordInput) => (metricProp ? Number(fieldValue(r, metricProp)) : 1);

  // cells: group → split → numbers
  const cells = new Map<string, Map<string, number[]>>();
  const splitKeys = new Set<string>();
  for (const r of rows) {
    const groups = q.group_by ? keysFor(r, q.group_by, props, q.bucket) : ["Total"];
    const splits = q.split_by ? keysFor(r, q.split_by, props) : [q.metric.agg === "count" ? "Count" : (props.get(metricProp ?? "")?.name ?? "Value")];
    for (const g of groups) {
      const byS = cells.get(g) ?? new Map<string, number[]>();
      for (const s of splits) {
        splitKeys.add(s);
        const list = byS.get(s) ?? [];
        list.push(value(r));
        byS.set(s, list);
      }
      cells.set(g, byS);
    }
  }

  // Label order: select options first (natural), dates ascending, else by first seen.
  let labels = [...cells.keys()];
  const order = optionOrder(q.group_by, props);
  const dateGroup = q.group_by ? isDateField(q.group_by, props) : false;
  const natural = (a: string, b: string) => {
    if (a === EMPTY) return 1;
    if (b === EMPTY) return -1;
    if (dateGroup) return a.localeCompare(b);
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return 0;
  };
  labels.sort(natural);
  if (dateGroup && q.group_by && labels.length > 0) labels = fillDateGaps(labels, q.bucket ?? "day");

  const splitOrder = optionOrder(q.split_by, props);
  const splits = [...splitKeys].sort((a, b) => {
    const ia = splitOrder.indexOf(a), ib = splitOrder.indexOf(b);
    return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
  });

  const agg = (list: number[] | undefined) => (list ? aggregate(list, q.metric.agg) : 0);
  let series: ChartResult["series"] = splits.map((s) => ({
    name: s,
    color: colorOf(q.split_by, s, props),
    data: labels.map((l) => +agg(cells.get(l)?.get(s)).toFixed(4)),
  }));

  if (q.sort === "label" || q.sort === "value_desc" || q.sort === "value_asc") {
    const totals = labels.map((_, i) => series.reduce((a, s) => a + s.data[i]!, 0));
    const idx = labels.map((_, i) => i);
    if (q.sort === "label") idx.sort((a, b) => labels[a]!.localeCompare(labels[b]!));
    else idx.sort((a, b) => (q.sort === "value_desc" ? totals[b]! - totals[a]! : totals[a]! - totals[b]!));
    labels = idx.map((i) => labels[i]!);
    series = series.map((s) => ({ ...s, data: idx.map((i) => s.data[i]!) }));
  }

  if (q.cumulative) {
    series = series.map((s) => {
      let run = 0;
      return { ...s, data: s.data.map((n) => +(run += n).toFixed(4)) };
    });
  }

  // Single-series groupings over a select property carry the option colours.
  if (!q.split_by && series.length === 1 && q.group_by) {
    const colors = labels.map((l) => colorOf(q.group_by, l, props));
    if (colors.some(Boolean)) series[0]!.colors = colors;
  }

  return {
    labels: labels.slice(0, q.limit),
    series: series.map((s) => ({ ...s, data: s.data.slice(0, q.limit), ...(s.colors ? { colors: s.colors.slice(0, q.limit) } : {}) })),
    total: rows.length,
    metric: { agg: q.metric.agg, property: metricProp },
  };
}

/** Insert empty buckets between the first and last date bucket (max 400). */
function fillDateGaps(labels: string[], bucket: NonNullable<ChartQuery["bucket"]>): string[] {
  const real = labels.filter((l) => l !== EMPTY);
  const hasEmpty = real.length !== labels.length;
  if (real.length < 2 || bucket === "quarter" || bucket === "year") return labels;
  const parse = (l: string) => (bucket === "month" ? Date.UTC(+l.slice(0, 4), +l.slice(5, 7) - 1, 1) : Date.parse(`${l}T00:00:00Z`));
  const out: string[] = [];
  let t = parse(real[0]!);
  const end = parse(real[real.length - 1]!);
  while (t <= end && out.length < 400) {
    out.push(bucketKey(t, bucket));
    if (bucket === "month") {
      const d = new Date(t);
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    } else t += (bucket === "week" ? 7 : 1) * 86_400_000;
  }
  return hasEmpty ? [...out, EMPTY] : out;
}

/** Neutralise spreadsheet formula injection (CWE-1236) and quote a CSV cell. */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : Array.isArray(v) ? v.join("; ") : v instanceof Date ? v.toISOString() : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
