-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — notifications, publishing, and file-upload plumbing.
-- (comments and files tables already exist from earlier migrations.)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Notifications (mentions, assignments, comments, invites) ────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,       -- mention | comment | invite | assignment | system
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  target_type     TEXT,                -- page | block | record | comment
  target_id       UUID,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, read_at, created_at DESC);

-- ─── Publishing (public, read-only pages) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS publications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       UUID NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL UNIQUE,
  -- Optional password protection (Argon2id hash; NULL = open).
  password_hash TEXT,
  seo           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { title, description, image }
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  view_count    BIGINT NOT NULL DEFAULT 0,
  published_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publications_slug_idx ON publications (slug);

-- ─── Files: upload lifecycle (metadata already stored in `files`) ────────────
-- Track whether the object bytes have actually landed in object storage.
ALTER TABLE files ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'; -- pending | ready

DO $$ BEGIN
  CREATE TRIGGER trg_publications_updated BEFORE UPDATE ON publications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
