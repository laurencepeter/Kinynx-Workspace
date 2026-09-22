import type pg from "pg";
import type { Entitlements } from "@kinynx/shared";
import type { Config } from "./config.js";
import type { EmailProvider } from "./email/index.js";
import type { RealtimeHub } from "./realtime/hub.js";

export interface AuthUser {
  id: string;
  email: string;
}

declare module "fastify" {
  interface FastifyInstance {
    db: pg.Pool;
    config: Config;
    entitlements: Entitlements;
    email: EmailProvider;
    hub: RealtimeHub;
    /** Verifies the bearer token and sets request.user, or replies 401. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: AuthUser;
  }
}
