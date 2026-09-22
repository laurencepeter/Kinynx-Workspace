/**
 * Domain event bus. Routes emit events after successful mutations; the
 * automation engine (and, later, integrations/analytics) subscribe. In-process
 * for a single node; for multi-node, emit onto the same Redis bus used by
 * realtime. Decoupled from HTTP so any producer can raise events.
 */
import { EventEmitter } from "node:events";

export type TriggerType =
  | "page.created"
  | "record.created"
  | "record.updated"
  | "comment.added"
  | "task.completed"
  | "invite.accepted";

export interface DomainEvent {
  type: TriggerType;
  workspaceId: string;
  organizationId: string;
  actorEmail?: string;
  /** Payload used for filter matching and action templating. */
  data: Record<string, unknown>;
}

export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(50);
  }
  publish(event: DomainEvent): void {
    this.emitter.emit("event", event);
  }
  subscribe(handler: (event: DomainEvent) => void): void {
    this.emitter.on("event", handler);
  }
}
