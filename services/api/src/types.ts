import type pg from "pg";
import type { Entitlements } from "@kinynx/shared";
import type { Config } from "./config.js";
import type { EmailProvider } from "./email/index.js";
import type { RealtimeHub } from "./realtime/hub.js";
import type { StorageDriver } from "./storage/index.js";
import type { EventBus } from "./automation/events.js";
import type { AIProvider } from "./ai/index.js";
import type { BillingProvider } from "./billing/index.js";

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
    storage: StorageDriver;
    events: EventBus;
    ai: AIProvider | null;
    billing: BillingProvider;
    /** Verifies the bearer token and sets request.user, or replies 401. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: AuthUser;
  }
}
