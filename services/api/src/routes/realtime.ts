import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { can } from "@kinynx/permissions";
import { verifyAccessToken } from "../auth/tokens.js";
import { workspaceRole } from "../access.js";
import type { PresenceState } from "../realtime/hub.js";

/**
 * WS endpoint: /api/realtime?workspaceId=<uuid>&token=<access token>
 * Browsers cannot set Authorization headers on WebSocket handshakes, so the
 * access token is passed as a query parameter and verified here. Permission to
 * read the workspace is enforced before joining the room (server-side).
 */
export async function registerRealtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/realtime", { websocket: true }, async (socket: WebSocket, request) => {
    const q = request.query as { workspaceId?: string; token?: string };
    const close = (code: number, reason: string) => {
      try {
        socket.send(JSON.stringify({ type: "error", code, reason }));
      } catch {
        /* ignore */
      }
      socket.close(code, reason);
    };

    if (!q.workspaceId || !q.token) return close(4400, "workspaceId and token required");

    let userId: string;
    let email: string;
    try {
      const claims = await verifyAccessToken(q.token, app.config.JWT_SECRET);
      userId = claims.sub;
      email = claims.email;
    } catch {
      return close(4401, "invalid token");
    }

    const role = await workspaceRole(app.db, userId, q.workspaceId);
    if (!can(role, "workspace:read")) return close(4403, "forbidden");

    const connId = randomUUID();
    app.hub.join(connId, socket, q.workspaceId, { userId, email, pageId: null, state: "viewing" });
    // Send the joiner the current presence snapshot immediately.
    socket.send(
      JSON.stringify({ type: "presence", workspaceId: q.workspaceId, users: app.hub.presenceSnapshot(q.workspaceId) }),
    );

    socket.on("message", (raw: Buffer) => {
      let msg: { type?: string; pageId?: string; state?: PresenceState };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "presence") {
        app.hub.updatePresence(connId, {
          pageId: msg.pageId ?? null,
          state: msg.state === "editing" ? "editing" : "viewing",
        });
      }
    });

    socket.on("close", () => app.hub.leave(connId));
    socket.on("error", () => app.hub.leave(connId));
  });
}
