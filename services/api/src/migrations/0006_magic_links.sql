-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — passwordless magic-link sign-in.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS magic_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,      -- sha256 of the raw token
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links (email);
