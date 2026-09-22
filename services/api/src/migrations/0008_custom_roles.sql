-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — custom roles (Enterprise advanced_permissions).
-- A custom role is an org-defined, named role with a base permission level
-- (owner/admin/editor/commenter/viewer). Assigning it elevates a user's
-- effective role at a scope — it can only GRANT, never restrict. `extra_actions`
-- is reserved for future fine-grained per-action grants.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS custom_roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  base_role       kinynx_role NOT NULL DEFAULT 'viewer',
  extra_actions   TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS custom_roles_org_idx ON custom_roles (organization_id);

CREATE TABLE IF NOT EXISTS custom_role_assignments (
  custom_role_id UUID NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL,   -- organization | workspace
  scope_id       UUID NOT NULL,
  PRIMARY KEY (custom_role_id, user_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS custom_role_assign_user_idx ON custom_role_assignments (user_id);
CREATE INDEX IF NOT EXISTS custom_role_assign_scope_idx ON custom_role_assignments (scope_type, scope_id);
