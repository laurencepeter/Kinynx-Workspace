/**
 * Realtime collaboration hub: presence + live-sync fan-out.
 *
 * Every connection joins one workspace "room". The hub tracks who is present,
 * what page they are on, and whether they are viewing or editing — so clients
 * can show "Laurence is editing…", "Sarah is viewing…" indicators. Any change
 * (from a WebSocket message OR a REST mutation) is broadcast to the room so all
 * clients live-sync without polling.
 *
 * This implementation is in-process (correct for a single API node — the common
 * self-host case). For horizontal scale, swap the internal fan-out for a Redis
 * pub/sub bus: publish() would also PUBLISH to a channel, and each node would
 * SUBSCRIBE and re-broadcast to its local sockets. The interface below is what
 * that swap would preserve.
 */
import type { WebSocket } from "ws";

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
  | { type: "block.deleted"; pageId: string; blockId: string; by: string };

export class RealtimeHub {
  private conns = new Map<string, Connection>();
  private byWorkspace = new Map<string, Set<string>>();

  join(connId: string, socket: WebSocket, workspaceId: string, presence: Presence): void {
    this.conns.set(connId, { socket, workspaceId, presence });
    let set = this.byWorkspace.get(workspaceId);
    if (!set) this.byWorkspace.set(workspaceId, (set = new Set()));
    set.add(connId);
    this.broadcastPresence(workspaceId);
  }

  leave(connId: string): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.conns.delete(connId);
    this.byWorkspace.get(conn.workspaceId)?.delete(connId);
    this.broadcastPresence(conn.workspaceId);
  }

  updatePresence(connId: string, partial: Partial<Pick<Presence, "pageId" | "state">>): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    Object.assign(conn.presence, partial);
    this.broadcastPresence(conn.workspaceId);
  }

  /** Snapshot of who is present in a workspace (deduped per user+page+state). */
  presenceSnapshot(workspaceId: string): Presence[] {
    const ids = this.byWorkspace.get(workspaceId);
    if (!ids) return [];
    return [...ids].map((id) => this.conns.get(id)!.presence);
  }

  /** Broadcast any event to every socket in a workspace room. */
  publish(workspaceId: string, event: RealtimeEvent): void {
    const ids = this.byWorkspace.get(workspaceId);
    if (!ids) return;
    const payload = JSON.stringify(event);
    for (const id of ids) {
      const conn = this.conns.get(id);
      if (conn && conn.socket.readyState === conn.socket.OPEN) {
        conn.socket.send(payload);
      }
    }
  }

  private broadcastPresence(workspaceId: string): void {
    this.publish(workspaceId, {
      type: "presence",
      workspaceId,
      users: this.presenceSnapshot(workspaceId),
    });
  }
}
