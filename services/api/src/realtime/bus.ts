/**
 * Realtime bus: cross-node fan-out + shared presence store.
 *
 * The RealtimeHub keeps LOCAL WebSocket sockets; the bus is what lets multiple
 * API replicas act as one. Two drivers:
 *   - InMemoryBus : single-node. Presence in a local Map, no cross-node fan-out.
 *   - RedisBus    : multi-node. Presence in Redis hashes, events over pub/sub.
 *
 * Contract: publish() fans an event to OTHER nodes only (the caller has already
 * delivered to its own local sockets). The bus tags messages with a node id and
 * never re-delivers a node its own message, so there is no echo loop.
 */
import type { Presence, RealtimeEvent } from "./hub.js";

export interface RealtimeBus {
  /** Register the handler invoked for events published by OTHER nodes. */
  onRemote(handler: (workspaceId: string, event: RealtimeEvent) => void): void;
  /** Fan an event out to other nodes. */
  publish(workspaceId: string, event: RealtimeEvent): void;
  presenceSet(workspaceId: string, connId: string, presence: Presence): Promise<void>;
  presenceDelete(workspaceId: string, connId: string): Promise<void>;
  presenceList(workspaceId: string): Promise<Presence[]>;
  close(): Promise<void>;
}

export class InMemoryBus implements RealtimeBus {
  private presence = new Map<string, Map<string, Presence>>();
  onRemote(): void {
    /* single node: no remote events */
  }
  publish(): void {
    /* single node: local delivery already happened in the hub */
  }
  async presenceSet(workspaceId: string, connId: string, presence: Presence): Promise<void> {
    let m = this.presence.get(workspaceId);
    if (!m) this.presence.set(workspaceId, (m = new Map()));
    m.set(connId, presence);
  }
  async presenceDelete(workspaceId: string, connId: string): Promise<void> {
    this.presence.get(workspaceId)?.delete(connId);
  }
  async presenceList(workspaceId: string): Promise<Presence[]> {
    return [...(this.presence.get(workspaceId)?.values() ?? [])];
  }
  async close(): Promise<void> {
    this.presence.clear();
  }
}

const CHANNEL = "kinynx:rt";
const presenceKey = (workspaceId: string) => `kinynx:presence:${workspaceId}`;

export class RedisBus implements RealtimeBus {
  private pub: import("ioredis").Redis;
  private sub: import("ioredis").Redis;
  private cmd: import("ioredis").Redis;
  private nodeId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private handler: ((workspaceId: string, event: RealtimeEvent) => void) | null = null;
  private closed = false;

  constructor(RedisCtor: typeof import("ioredis").Redis, url: string) {
    this.pub = new RedisCtor(url);
    this.sub = new RedisCtor(url);
    this.cmd = new RedisCtor(url);
    // Never let a transient connection error surface as an unhandled rejection.
    for (const c of [this.pub, this.sub, this.cmd]) c.on("error", () => {});
    void this.sub.subscribe(CHANNEL);
    this.sub.on("message", (_channel: string, raw: string) => {
      try {
        const msg = JSON.parse(raw) as { node: string; workspaceId: string; event: RealtimeEvent };
        if (msg.node === this.nodeId) return; // skip our own messages (no echo)
        this.handler?.(msg.workspaceId, msg.event);
      } catch {
        /* ignore malformed */
      }
    });
  }

  onRemote(handler: (workspaceId: string, event: RealtimeEvent) => void): void {
    this.handler = handler;
  }

  publish(workspaceId: string, event: RealtimeEvent): void {
    if (this.closed) return;
    this.pub.publish(CHANNEL, JSON.stringify({ node: this.nodeId, workspaceId, event })).catch(() => {});
  }

  async presenceSet(workspaceId: string, connId: string, presence: Presence): Promise<void> {
    if (this.closed) return;
    try {
      await this.cmd.hset(presenceKey(workspaceId), connId, JSON.stringify(presence));
      // Safety TTL so a crashed node's presence eventually clears.
      await this.cmd.expire(presenceKey(workspaceId), 3600);
    } catch {
      /* best-effort */
    }
  }
  async presenceDelete(workspaceId: string, connId: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.cmd.hdel(presenceKey(workspaceId), connId);
    } catch {
      /* best-effort */
    }
  }
  async presenceList(workspaceId: string): Promise<Presence[]> {
    if (this.closed) return [];
    try {
      const values = await this.cmd.hvals(presenceKey(workspaceId));
      return values.map((v) => JSON.parse(v) as Presence);
    } catch {
      return [];
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.sub.removeAllListeners("message");
    await Promise.allSettled([this.pub.quit(), this.sub.quit(), this.cmd.quit()]);
  }
}

/** Build the bus for a deployment. Falls back to in-memory if Redis is absent. */
export async function createRealtimeBus(redisUrl?: string): Promise<RealtimeBus> {
  if (!redisUrl) return new InMemoryBus();
  try {
    const { Redis } = await import("ioredis");
    return new RedisBus(Redis, redisUrl);
  } catch (err) {
    console.warn(`[realtime] Redis unavailable (${(err as Error).message}); using in-memory bus.`);
    return new InMemoryBus();
  }
}
