-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — Phase 1 foundation schema
-- Multi-tenant: User → Organization → Workspace → Page → Block
-- A user may belong to many organizations; an org may hold many workspaces.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid, crypt (not used for pw here)

-- Reusable role type across every scope.
DO $$ BEGIN
  CREATE TYPE kinynx_role AS ENUM ('owner','admin','editor','commenter','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kinynx_plan AS ENUM ('community','team','enterprise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  -- Case-insensitive uniqueness without the citext extension.
  email_norm     TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  display_name   TEXT NOT NULL DEFAULT '',
  -- Argon2id encoded hash. NULL for accounts that only use SSO/magic-link.
  password_hash  TEXT,
  avatar_url     TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_norm_key ON users (email_norm);

-- ─── Organizations (tenant root) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  -- Verified email domains, used for SSO auto-discovery (Enterprise).
  domains        TEXT[] NOT NULL DEFAULT '{}',
  plan           kinynx_plan NOT NULL DEFAULT 'community',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            kinynx_role NOT NULL DEFAULT 'viewer',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_members_user_idx ON organization_members (user_id);

-- ─── Workspaces ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  icon            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_org_idx ON workspaces (organization_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         kinynx_role NOT NULL DEFAULT 'viewer',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

-- ─── Pages (nestable tree) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id      UUID REFERENCES pages(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT 'Untitled',
  icon           TEXT,
  -- Ordering among siblings (lexicographic fractional index for cheap reorders).
  position       TEXT NOT NULL DEFAULT 'n',
  archived_at    TIMESTAMPTZ,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pages_workspace_idx ON pages (workspace_id);
CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages (parent_id);

-- Optional per-page ACL entries (advanced_permissions feature).
CREATE TABLE IF NOT EXISTS page_permissions (
  page_id   UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      kinynx_role NOT NULL,
  PRIMARY KEY (page_id, user_id)
);

-- ─── Blocks (block-based editor content) ────────────────────────────────────
-- Blocks are first-class rows, not opaque JSON blobs, so we can index, comment
-- on, and (later) CRDT-merge them individually.
CREATE TABLE IF NOT EXISTS blocks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id    UUID REFERENCES blocks(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,   -- heading|paragraph|image|file|table|database|
                                -- kanban|checklist|code|quote|divider|embed|child_page
  -- Type-specific content (text, level, language, url, checked, …).
  content      JSONB NOT NULL DEFAULT '{}'::jsonb,
  position     TEXT NOT NULL DEFAULT 'n',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocks_page_idx ON blocks (page_id);
CREATE INDEX IF NOT EXISTS blocks_parent_idx ON blocks (parent_id);

-- ─── Sessions / refresh tokens ──────────────────────────────────────────────
-- Only a hash of the refresh token is stored; the raw token lives client-side.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip            INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ─── Files (metadata only; objects live in S3-compatible storage) ───────────
CREATE TABLE IF NOT EXISTS files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  storage_key     TEXT NOT NULL,          -- object key in the bucket
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_org_idx ON files (organization_id);

-- ─── Enterprise license (uploaded, offline-verified) ────────────────────────
CREATE TABLE IF NOT EXISTS licenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  license_id      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  signature       TEXT NOT NULL,
  installed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Audit logs (Enterprise reads them; we always write core events cheaply) ─
CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip              INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_org_time_idx ON audit_logs (organization_id, created_at DESC);

-- updated_at maintenance
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','organizations','workspaces','pages','blocks'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_updated ON %1$s;
       CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t);
  END LOOP;
END $$;
