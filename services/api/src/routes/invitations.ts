import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCan } from "@kinynx/permissions";
import { query } from "../db/pool.js";
import { hashToken } from "../auth/tokens.js";
import { orgRole } from "../access.js";

/**
 * Invitations support two modes:
 *   - targeted email invite  (email set, single-use) → sends a link by email
 *   - shareable link         (email null, max_uses>1) → returns a link to share
 * Accepting adds the user to the org (and optionally a workspace and/or group).
 */
export async function registerInvitationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/organizations/:orgId/invitations", { preHandler: app.authenticate }, async (request, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        email: z.string().email().optional(),
        workspace_id: z.string().uuid().optional(),
        group_id: z.string().uuid().optional(),
        role: z.enum(["admin", "editor", "commenter", "viewer"]).default("editor"),
        max_uses: z.number().int().min(1).max(1000).optional(),
        expires_in_days: z.number().int().min(1).max(90).default(14),
      })
      .parse(request.body);

    assertCan(await orgRole(app.db, request.user!.id, orgId), "org:manage_members");

    // Validate nested scopes belong to the org.
    if (body.workspace_id) {
      const ok = await query(app.db, "SELECT 1 FROM workspaces WHERE id=$1 AND organization_id=$2", [body.workspace_id, orgId]);
      if (ok.length === 0) return reply.code(400).send({ error: "workspace not in this organization" });
    }
    if (body.group_id) {
      const ok = await query(app.db, "SELECT 1 FROM groups WHERE id=$1 AND organization_id=$2", [body.group_id, orgId]);
      if (ok.length === 0) return reply.code(400).send({ error: "group not in this organization" });
    }

    const rawToken = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + body.expires_in_days * 86_400_000);
    const maxUses = body.max_uses ?? (body.email ? 1 : 25);

    const rows = await query<{ id: string }>(
      app.db,
      `INSERT INTO invitations (organization_id, workspace_id, group_id, email, role, token_hash, max_uses, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, body.workspace_id ?? null, body.group_id ?? null, body.email ?? null, body.role, hashToken(rawToken), maxUses, request.user!.id, expires],
    );

    const link = `${app.config.PUBLIC_APP_URL}/invite/${rawToken}`;

    // Email targeted invites; shareable links are just returned to the caller.
    if (body.email) {
      const org = (await query<{ name: string }>(app.db, "SELECT name FROM organizations WHERE id=$1", [orgId]))[0];
      await app.email
        .send({
          to: body.email,
          subject: `You're invited to ${org?.name ?? "a Kinynx workspace"}`,
          html: `<p>You've been invited to join <b>${escapeHtml(org?.name ?? "a workspace")}</b> on Kinynx as <b>${body.role}</b>.</p>
                 <p><a href="${link}">Accept your invitation</a></p>
                 <p>This link expires ${expires.toDateString()}.</p>`,
        })
        .catch((err) => app.log.warn(`invite email failed: ${(err as Error).message}`));
    }

    return reply.code(201).send({ invitation: { id: rows[0]!.id, role: body.role, expires_at: expires }, link });
  });

  // Public: look up an invite by token so the accept screen can show context.
  app.get("/api/invitations/:token", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(request.params);
    const row = await lookupValidInvite(app, token);
    if (!row) return reply.code(404).send({ error: "invitation invalid or expired" });
    const org = (await query<{ name: string }>(app.db, "SELECT name FROM organizations WHERE id=$1", [row.organization_id]))[0];
    return reply.send({ organization: org?.name, role: row.role, targeted: row.email != null });
  });

  // Accept an invite (must be signed in as the user joining).
  app.post("/api/invitations/accept", { preHandler: app.authenticate }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(request.body);
    const invite = await lookupValidInvite(app, token);
    if (!invite) return reply.code(404).send({ error: "invitation invalid or expired" });

    // Targeted invites must be redeemed by the addressed email.
    if (invite.email && invite.email.toLowerCase() !== request.user!.email.toLowerCase()) {
      return reply.code(403).send({ error: "this invitation was issued to a different email" });
    }

    const uid = request.user!.id;
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [invite.organization_id, uid, invite.role],
      );
      if (invite.workspace_id) {
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (workspace_id, user_id) DO NOTHING`,
          [invite.workspace_id, uid, invite.role],
        );
      }
      if (invite.group_id) {
        await client.query("INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
          invite.group_id,
          uid,
        ]);
      }
      await client.query("UPDATE invitations SET used_count = used_count + 1 WHERE id = $1", [invite.id]);
      await client.query(
        "INSERT INTO audit_logs (organization_id, actor_id, action, target_type, target_id, ip) VALUES ($1,$2,'invitation.accept','invitation',$3,$4)",
        [invite.organization_id, uid, invite.id, request.ip],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (invite.workspace_id) {
      app.events.publish({
        type: "invite.accepted",
        workspaceId: invite.workspace_id,
        organizationId: invite.organization_id,
        actorEmail: request.user!.email,
        data: { invitation_id: invite.id, role: invite.role, email: request.user!.email },
      });
    }
    return reply.send({ ok: true, organization_id: invite.organization_id, role: invite.role });
  });

  app.post("/api/invitations/:id/revoke", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const inv = (await query<{ organization_id: string }>(app.db, "SELECT organization_id FROM invitations WHERE id=$1", [id]))[0];
    if (!inv) return reply.code(404).send({ error: "not found" });
    assertCan(await orgRole(app.db, request.user!.id, inv.organization_id), "org:manage_members");
    await query(app.db, "UPDATE invitations SET revoked_at = now() WHERE id = $1", [id]);
    return reply.code(204).send();
  });
}

interface InviteRow {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  group_id: string | null;
  email: string | null;
  role: "admin" | "editor" | "commenter" | "viewer";
}

async function lookupValidInvite(app: FastifyInstance, rawToken: string): Promise<InviteRow | null> {
  const rows = await query<InviteRow>(
    app.db,
    `SELECT id, organization_id, workspace_id, group_id, email, role
       FROM invitations
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND used_count < max_uses`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
