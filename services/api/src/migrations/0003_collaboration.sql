-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — Phase 2 collaboration: groups, invitations, versioning/history,
-- page linking, and color coding.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Color coding (workspaces, pages, groups) ───────────────────────────────
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE pages      ADD COLUMN IF NOT EXISTS color TEXT;

-- ─── Groups (departments / project teams) ───────────────────────────────────
-- Groups can be created manually or synced from a directory (LDAP/Authentik/OIDC).
CREATE TABLE IF NOT EXISTS groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  color           TEXT,
  icon            TEXT,
  -- Provenance: manual, or a directory that owns this group's membership.
  source          TEXT NOT NULL DEFAULT 'manual',  -- manual|ldap|authentik|oidc|scim
  external_id     TEXT,                            -- directory group id/DN when synced
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS groups_org_idx ON groups (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS groups_source_ext_idx
  ON groups (organization_id, source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS group_members (
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);

-- A group can be granted a role on an organization or a workspace. This is how
-- "invite a whole department/team to a project" works.
CREATE TABLE IF NOT EXISTS group_grants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,             -- organization | workspace
  scope_id   UUID NOT NULL,
  role       kinynx_role NOT NULL,
  UNIQUE (group_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS group_grants_scope_idx ON group_grants (scope_type, scope_id);

-- ─── Invitations (email invite or shareable link) ───────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id        UUID REFERENCES groups(id) ON DELETE CASCADE,
  -- NULL email => a shareable link anyone can redeem (until it expires/uses up).
  email           TEXT,
  role            kinynx_role NOT NULL DEFAULT 'editor',
  token_hash      TEXT NOT NULL UNIQUE,      -- sha256 of the raw invite token
  max_uses        INTEGER NOT NULL DEFAULT 1,
  used_count      INTEGER NOT NULL DEFAULT 0,
  invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_org_idx ON invitations (organization_id);

-- ─── Page versioning / history (backup + restore) ───────────────────────────
CREATE TABLE IF NOT EXISTS page_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  -- Full snapshot of the page's blocks at this version (for restore).
  snapshot    JSONB NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, version)
);
CREATE INDEX IF NOT EXISTS page_versions_page_idx ON page_versions (page_id, version DESC);

-- ─── Page links (backlinks / linked references) ─────────────────────────────
CREATE TABLE IF NOT EXISTS page_links (
  from_page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id   UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id, to_page_id)
);
CREATE INDEX IF NOT EXISTS page_links_to_idx ON page_links (to_page_id);

DO $$ BEGIN
  CREATE TRIGGER trg_groups_updated BEFORE UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
