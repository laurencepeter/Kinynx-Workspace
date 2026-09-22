/**
 * Automation engine: on each domain event, find matching enabled automations,
 * apply their filter, run their actions, and log a run. Failures in one
 * automation never affect another or the request that raised the event.
 */
import type pg from "pg";
import { query } from "../db/pool.js";
import type { EmailProvider } from "../email/index.js";
import { runAction, type Action, type ActionResult } from "./actions.js";
import type { DomainEvent, EventBus } from "./events.js";

interface AutomationRow {
  id: string;
  actions: Action[];
  trigger_filter: Record<string, unknown>;
  secret: string;
}

export class AutomationEngine {
  constructor(
    private readonly db: pg.Pool,
    private readonly email: EmailProvider,
  ) {}

  /** Wire the engine to an event bus. */
  attach(bus: EventBus): void {
    bus.subscribe((event) => void this.handle(event));
  }

  async handle(event: DomainEvent): Promise<void> {
    let automations: AutomationRow[];
    try {
      automations = await query<AutomationRow>(
        this.db,
        "SELECT id, actions, trigger_filter, secret FROM automations WHERE workspace_id=$1 AND trigger_type=$2 AND enabled",
        [event.workspaceId, event.type],
      );
    } catch {
      return; // never let automation errors bubble into the request path
    }

    for (const auto of automations) {
      if (!matchesFilter(auto.trigger_filter, event.data)) {
        await this.log(auto.id, "skipped", event, { reason: "filter" });
        continue;
      }
      const results: ActionResult[] = [];
      for (const action of auto.actions) {
        results.push(await runAction(action, event, { db: this.db, email: this.email, secret: auto.secret }));
      }
      const status = results.every((r) => r.ok) ? "success" : "error";
      await this.log(auto.id, status, event, { results });
    }
  }

  private async log(automationId: string, status: string, event: DomainEvent, result: unknown): Promise<void> {
    await query(
      this.db,
      "INSERT INTO automation_runs (automation_id, status, event, result) VALUES ($1,$2,$3,$4)",
      [automationId, status, JSON.stringify(event), JSON.stringify(result)],
    ).catch(() => {});
  }
}

/** Every key in the filter must equal the corresponding event.data value. */
export function matchesFilter(filter: Record<string, unknown>, data: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (data[k] !== v) return false;
  }
  return true;
}
