/**
 * Realtime collaboration hub: presence + live-sync fan-out.
 *
 * The hub owns the LOCAL WebSocket sockets. Cross-node fan-out and the shared
 * presence store are delegated to a {@link RealtimeBus}, so a single node
 * (InMemoryBus) and a cluster of replicas (RedisBus) behave identically to
 * clients: "Laurence is editing…", "Sarah is viewing…" and live block updates
 * arrive everywhere without polling.
 */
import type { WebSocket } from "ws";
import type { RealtimeBus } from "./bus.js";

export type PresenceState = "viewing" | "editing";

export interface Presence {
  userId: string;
  email: string;
  pageId: string | null;
  state: PresenceState;
}

interface Connection {
  socket: WebSocket;
  workspaceId: string;
  presence: Presence;
}

export type RealtimeEvent =
  | { type: "presence"; workspaceId: string; users: Presence[] }
  | { type: "page.updated"; pageId: string; by: string }
  | { type: "page.version"; pageId: string; version: number; by: string }
  | { type: "block.created"; pageId: string; block: unknown; by: string }
  | { type: "block.updated"; pageId: string; block: unknown; by: string }
  | { type: "block.deleted"; pageId: string; blockId: string; by: string }
  | { type: "comment.created"; targetType: string; targetId: string; comment: unknown; by: string };

export class RealtimeHub {
  private conns = new Map<string, Connection>();
  private byWorkspace = new Map<string, Set<string>>();

  constructor(private readonly bus: RealtimeBus) {
    // Events published by other nodes are delivered to our local sockets only.
    this.bus.onRemote((workspaceId, event) => this.deliverLocal(workspaceId, event));
  }

  async join(connId: string, socket: WebSocket, workspaceId: string, presence: Presence): Promise<void> {
    this.conns.set(connId, { socket, workspaceId, presence });
    let set = this.byWorkspace.get(workspaceId);
    if (!set) this.byWorkspace.set(workspaceId, (set = new Set()));
    set.add(connId);
    await this.bus.presenceSet(workspaceId, connId, presence);
    await this.broadcastPresence(workspaceId);
  }

  async leave(connId: string): Promise<void> {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.conns.delete(connId);
    this.byWorkspace.get(conn.workspaceId)?.delete(connId);
    await this.bus.presenceDelete(conn.workspaceId, connId);
    await this.broadcastPresence(conn.workspaceId);
  }

  async updatePresence(connId: string, partial: Partial<Pick<Presence, "pageId" | "state">>): Promise<void> {
    const conn = this.conns.get(connId);
    if (!conn) return;
    Object.assign(conn.presence, partial);
    await this.bus.presenceSet(conn.workspaceId, connId, conn.presence);
    await this.broadcastPresence(conn.workspaceId);
  }

  /** Presence across ALL nodes (from the shared store). */
  presenceSnapshot(workspaceId: string): Promise<Presence[]> {
    return this.bus.presenceList(workspaceId);
  }

  /** Broadcast an event to this workspace's sockets on every node. */
  publish(workspaceId: string, event: RealtimeEvent): void {
    this.deliverLocal(workspaceId, event); // our own sockets, immediately
    this.bus.publish(workspaceId, event); // other nodes
  }

  /** Send to this node's local sockets only (used for our own + remote events). */
  private deliverLocal(workspaceId: string, event: RealtimeEvent): void {
    const ids = this.byWorkspace.get(workspaceId);
    if (!ids) return;
    const payload = JSON.stringify(event);
    for (const id of ids) {
      const conn = this.conns.get(id);
      if (conn && conn.socket.readyState === conn.socket.OPEN) conn.socket.send(payload);
    }
  }

  private async broadcastPresence(workspaceId: string): Promise<void> {
    const users = await this.bus.presenceList(workspaceId);
    this.publish(workspaceId, { type: "presence", workspaceId, users });
  }
}
