/**
 * Workflows & progress tracking. A workflow turns a database's select property
 * into an ordered pipeline of stages, each in a category (todo → active → done),
 * with optional allowed transitions and WIP limits enforced server-side.
 *
 * Progress metrics are derived by replaying the append-only `record_events`
 * log, so burn-up / throughput / lead time are accurate even after edits.
 * Everything here is pure; routes do the I/O and authorization.
 */
import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const StageSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: hex.default("#9085e9"),
  category: z.enum(["todo", "active", "done"]),
  wip_limit: z.number().int().min(1).max(10_000).nullable().default(null),
});

export const WorkflowSchema = z
  .object({
    status_property_id: z.string().uuid(),
    due_property_id: z.string().uuid().nullable().default(null),
    stages: z.array(StageSchema).min(1).max(30),
    transitions: z.record(z.string().max(60), z.array(z.string().max(60)).max(30)).default({}),
    enforce: z.boolean().default(true),
  })
  .superRefine((w, ctx) => {
    const names = w.stages.map((s) => s.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "stage names must be unique" });
    for (const [from, tos] of Object.entries(w.transitions)) {
      if (!names.includes(from)) ctx.addIssue({ code: "custom", message: `unknown transition source "${from}"` });
      for (const t of tos) if (!names.includes(t)) ctx.addIssue({ code: "custom", message: `unknown transition target "${t}"` });
    }
  });

export type Stage = z.infer<typeof StageSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

export type TransitionCheck = { ok: true } | { ok: false; code: 409 | 422; error: string };

/**
 * Validate moving a record from `from` to `to`. `countInTarget` is the number of
 * records currently in the target stage (excluding the moving record).
 */
export function checkTransition(wf: Pick<Workflow, "stages" | "transitions">, from: string | null, to: string, countInTarget: number): TransitionCheck {
  const target = wf.stages.find((s) => s.name === to);
  if (!target) return { ok: false, code: 422, error: `"${to}" is not a stage of this workflow` };
  if (from === to) return { ok: true };
  if (from !== null && wf.stages.some((s) => s.name === from)) {
    const allowed = wf.transitions[from];
    if (allowed && !allowed.includes(to)) return { ok: false, code: 422, error: `moving from "${from}" to "${to}" is not allowed` };
  }
  if (target.wip_limit !== null && countInTarget >= target.wip_limit) {
    return { ok: false, code: 409, error: `"${to}" is at its WIP limit (${target.wip_limit})` };
  }
  return { ok: true };
}

export function categoryOf(wf: Pick<Workflow, "stages">, stage: unknown): Stage["category"] | null {
  return wf.stages.find((s) => s.name === stage)?.category ?? null;
}

export interface RecordEvent {
  record_id: string;
  kind: string;
  property_id: string | null;
  to_value: unknown;
  created_at: string | Date;
}

export interface ProgressInput {
  workflow: Pick<Workflow, "stages" | "status_property_id">;
  /** Current records (values only). */
  records: Array<{ id: string; values: Record<string, unknown>; created_at: string | Date }>;
  /** Events ordered by created_at ascending. */
  events: RecordEvent[];
  dueProperty: string | null;
  days: number;
  now?: number;
}

const DAY = 86_400_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export function computeProgress(input: ProgressInput) {
  const now = input.now ?? Date.now();
  const { workflow: wf } = input;
  const statusId = wf.status_property_id;

  // ── Current snapshot ───────────────────────────────────────────────────────
  const byStage = wf.stages.map((s) => ({ name: s.name, color: s.color, category: s.category, wip_limit: s.wip_limit, count: 0 }));
  const cat = { todo: 0, active: 0, done: 0, unset: 0 };
  let overdue = 0;
  for (const r of input.records) {
    const stage = r.values[statusId];
    const row = byStage.find((s) => s.name === stage);
    if (row) { row.count++; cat[row.category]++; } else cat.unset++;
    if (input.dueProperty && row?.category !== "done") {
      const due = Date.parse(String(r.values[input.dueProperty] ?? ""));
      if (!Number.isNaN(due) && due < now) overdue++;
    }
  }
  const total = input.records.length;

  // ── Replay events → per-day burn-up, completions, lead times ───────────────
  const start = now - (input.days - 1) * DAY;
  const days: string[] = [];
  for (let t = start; t <= now; t += DAY) days.push(dayKey(t));

  const stageOf = new Map<string, string | null>();
  const createdAt = new Map<string, number>();
  const firstActive = new Map<string, number>();
  const leadTimes: number[] = [];
  const cycleTimes: number[] = [];
  const completedOn = new Map<string, number>(); // day → completions
  const scopeAt = new Map<string, number>();
  const doneAt = new Map<string, number>();

  const isDone = (s: unknown) => categoryOf(wf, s) === "done";
  let alive = 0;
  let doneNow = 0;
  let di = 0;
  const flushUntil = (t: number) => {
    while (di < days.length && Date.parse(`${days[di]}T23:59:59.999Z`) < t) {
      scopeAt.set(days[di]!, alive);
      doneAt.set(days[di]!, doneNow);
      di++;
    }
  };

  for (const ev of input.events) {
    const t = new Date(ev.created_at).getTime();
    flushUntil(t);
    const prev = stageOf.get(ev.record_id) ?? null;
    let next: string | null = prev;
    if (ev.kind === "created") {
      alive++;
      createdAt.set(ev.record_id, t);
      const vals = (ev.to_value ?? {}) as Record<string, unknown>;
      next = vals[statusId] === undefined ? null : String(vals[statusId]);
    } else if (ev.kind === "stage_changed") {
      next = ev.to_value === null || ev.to_value === undefined ? null : String(ev.to_value);
    } else if (ev.kind === "deleted") {
      if (stageOf.has(ev.record_id) || createdAt.has(ev.record_id)) {
        alive--;
        if (isDone(prev)) doneNow--;
      }
      stageOf.delete(ev.record_id);
      createdAt.delete(ev.record_id);
      continue;
    } else continue;

    if (categoryOf(wf, next) === "active" && !firstActive.has(ev.record_id)) firstActive.set(ev.record_id, t);
    if (!isDone(prev) && isDone(next)) {
      doneNow++;
      const k = dayKey(t);
      completedOn.set(k, (completedOn.get(k) ?? 0) + 1);
      const c = createdAt.get(ev.record_id);
      if (c !== undefined && t >= start) leadTimes.push((t - c) / DAY);
      const a = firstActive.get(ev.record_id);
      if (a !== undefined && t >= start) cycleTimes.push((t - a) / DAY);
    } else if (isDone(prev) && !isDone(next)) doneNow--;
    stageOf.set(ev.record_id, next);
  }
  flushUntil(Infinity);

  const burnup = days.map((d) => ({ date: d, scope: scopeAt.get(d) ?? 0, done: doneAt.get(d) ?? 0, completed: completedOn.get(d) ?? 0 }));
  const completedInWindow = burnup.reduce((a, b) => a + b.completed, 0);
  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);
  const weeks = Math.max(1, input.days / 7);
  const remaining = total - cat.done;
  const perDay = completedInWindow / input.days;

  return {
    total,
    by_category: cat,
    by_stage: byStage,
    completion_pct: total ? +((cat.done / total) * 100).toFixed(1) : 0,
    overdue,
    wip_breaches: byStage.filter((s) => s.wip_limit !== null && s.count > s.wip_limit).map((s) => s.name),
    throughput_per_week: +(completedInWindow / weeks).toFixed(2),
    lead_time_days: avg(leadTimes),
    cycle_time_days: avg(cycleTimes),
    // Naive linear forecast from recent throughput; null when there is no signal.
    forecast_done_date: remaining > 0 && perDay > 0 ? dayKey(now + Math.ceil(remaining / perDay) * DAY) : remaining === 0 && total > 0 ? dayKey(now) : null,
    burnup,
  };
}
