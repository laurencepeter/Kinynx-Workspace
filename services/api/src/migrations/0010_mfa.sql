-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — TOTP multi-factor authentication (per-user).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret  TEXT;    -- base32 TOTP secret (pending or active)
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
