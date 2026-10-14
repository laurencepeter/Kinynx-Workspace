import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { hashToken } from "../auth/tokens.js";
import { orgRole } from "../access.js";

/**
 * SCIM 2.0 inbound provisioning (Enterprise `scim`). The IdP presents an
 * org-scoped bearer token and pushes Users/Groups here; we upsert into the core
 * users/organization_members/groups tables (the same targets as the pull-based
 * directory-sync). A minimal, interoperable subset: Users (create/get/list/
 * patch-active) and Groups (create/patch-members).
 */
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

function userResource(u: { id: string; email: string; display_name: string; is_active: boolean }) {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.email,
    name: { formatted: u.display_name },
    emails: [{ value: u.email, primary: true }],
    active: u.is_active,
    meta: { resourceType: "User" },
  };
}

export async function registerScimRoutes(app: FastifyInstance): Promise<void> {
  // Admin: (re)generate the org's SCIM bearer token (returned once).
  app.post("/api/organizations/:orgId/scim/token", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:update");
    if (!app.entitlements.features.scim) return reply.code(402).send({ error: "SCIM requires an Enterprise license" });
    const raw = `scim_${randomBytes(24).toString("base64url")}`;
    await query(app.db, "UPDATE organizations SET scim_token_hash=$2 WHERE id=$1", [orgId, hashToken(raw)]);
    return reply.send({ token: raw, endpoint: `${app.config.PUBLIC_APP_URL}/scim/v2` });
  });

  // Resolve the org from the SCIM bearer token; 401 otherwise. Also gate on entitlement.
  async function scimOrg(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    if (!app.entitlements.features.scim) {
      await reply.code(403).send({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "SCIM not enabled", status: "403" });
      return null;
    }
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      await reply.code(401).send({ detail: "missing bearer token", status: "401" });
      return null;
    }
    const rows = await query<{ id: string }>(app.db, "SELECT id FROM organizations WHERE scim_token_hash=$1", [hashToken(header.slice(7))]);
    if (rows.length === 0) {
      await reply.code(401).send({ detail: "invalid SCIM token", status: "401" });
      return null;
    }
    return rows[0]!.id;
  }

  // Create a user (provisioning).
  app.post("/scim/v2/Users", async (request, reply) => {
    const orgId = await scimOrg(request, reply);
    if (!orgId) return reply;
    const body = z
      .object({
        userName: z.string(),
        emails: z.array(z.object({ value: z.string(), primary: z.boolean().optional() })).optional(),
        name: z.object({ formatted: z.string().optional(), givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
        active: z.boolean().optional(),
      })
      .parse(request.body);
    const email = body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value ?? body.userName;
    const displayName = body.name?.formatted ?? ([body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") || email.split("@")[0]);

    const existing = await query<{ id: string; email: string; display_name: string; is_active: boolean }>(app.db, "SELECT id, email, display_name, is_active FROM users WHERE email_norm = lower($1)", [email]);
    let user = existing[0];
    if (!user) {
      user = (await query<{ id: string; email: string; display_name: string; is_active: boolean }>(app.db, "INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id, email, display_name, is_active", [email, displayName]))[0]!;
    }
    await query(app.db, "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'viewer') ON CONFLICT DO NOTHING", [orgId, user.id]);
    return reply.code(201).send(userResource(user));
  });

  app.get("/scim/v2/Users/:id", async (request, reply) => {
    const orgId = await scimOrg(request, reply);
    if (!orgId) return reply;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await query<{ id: string; email: string; display_name: string; is_active: boolean }>(
      app.db,
      "SELECT u.id, u.email, u.display_name, u.is_active FROM users u JOIN organization_members m ON m.user_id=u.id WHERE u.id=$1 AND m.organization_id=$2",
      [id, orgId],
    );
    if (rows.length === 0) return reply.code(404).send({ detail: "not found", status: "404" });
    return reply.send(userResource(rows[0]!));
  });

  // List (IdPs filter by userName to check existence).
  app.get("/scim/v2/Users", async (request, reply) => {
    const orgId = await scimOrg(request, reply);
    if (!orgId) return reply;
    const filter = (request.query as { filter?: string }).filter;
    const match = filter?.match(/userName eq "([^"]+)"/i);
    const rows = match
      ? await query<{ id: string; email: string; display_name: string; is_active: boolean }>(
          app.db,
          "SELECT u.id, u.email, u.display_name, u.is_active FROM users u JOIN organization_members m ON m.user_id=u.id WHERE u.email_norm=lower($1) AND m.organization_id=$2",
          [match[1], orgId],
        )
      : [];
    return reply.send({ schemas: [LIST_SCHEMA], totalResults: rows.length, Resources: rows.map(userResource), startIndex: 1, itemsPerPage: rows.length });
  });

  // Deactivate / reactivate (deprovisioning).
  app.patch("/scim/v2/Users/:id", async (request, reply) => {
    const orgId = await scimOrg(request, reply);
    if (!orgId) return reply;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // Support both PATCH Operations and a plain { active } body.
    const body = request.body as { active?: boolean; Operations?: Array<{ path?: string; value?: unknown }> };
    let active: boolean | undefined = body.active;
    for (const op of body.Operations ?? []) {
      if (op.path === "active") active = Boolean(op.value);
      else if (op.value && typeof op.value === "object" && "active" in op.value) active = Boolean((op.value as { active: unknown }).active);
    }
    if (typeof active === "boolean") {
      await query(app.db, "UPDATE users SET is_active=$2 WHERE id=$1", [id, active]);
    }
    const rows = await query<{ id: string; email: string; display_name: string; is_active: boolean }>(app.db, "SELECT id, email, display_name, is_active FROM users WHERE id=$1", [id]);
    if (rows.length === 0) return reply.code(404).send({ detail: "not found", status: "404" });
    return reply.send(userResource(rows[0]!));
  });

  // Create a group.
  app.post("/scim/v2/Groups", async (request, reply) => {
    const orgId = await scimOrg(request, reply);
    if (!orgId) return reply;
    const body = z.object({ displayName: z.string(), externalId: z.string().optional() }).parse(request.body);
    const row = (
      await query<{ id: string }>(
        app.db,
        `INSERT INTO groups (organization_id, name, source, external_id) VALUES ($1,$2,'scim',$3)
         ON CONFLICT (organization_id, name) DO UPDATE SET external_id = EXCLUDED.external_id RETURNING id`,
        [orgId, body.displayName, body.externalId ?? null],
      )
    )[0]!;
    return reply.code(201).send({ schemas: [GROUP_SCHEMA], id: row.id, displayName: body.displayName, meta: { resourceType: "Group" } });
  });

  // Patch group membership (add/remove members).
  app.patch("/scim/v2/Groups/:id", async (request, reply) => {
    const orgId = await scimOrg(request, reply);
    if (!orgId) return reply;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const owns = await query(app.db, "SELECT 1 FROM groups WHERE id=$1 AND organization_id=$2", [id, orgId]);
    if (owns.length === 0) return reply.code(404).send({ detail: "not found", status: "404" });
    const body = request.body as { Operations?: Array<{ op: string; path?: string; value?: Array<{ value: string }> }> };
    for (const op of body.Operations ?? []) {
      const members = Array.isArray(op.value) ? op.value : [];
      for (const m of members) {
        if (op.op.toLowerCase() === "add") await query(app.db, "INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, m.value]);
        else if (op.op.toLowerCase() === "remove") await query(app.db, "DELETE FROM group_members WHERE group_id=$1 AND user_id=$2", [id, m.value]);
      }
    }
    return reply.code(204).send();
  });
}
