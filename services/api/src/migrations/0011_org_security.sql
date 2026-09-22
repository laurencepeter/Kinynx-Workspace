-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — organization security policies (Enterprise advanced_security).
-- security = { "ip_allowlist": ["203.0.113.0/24", ...], "require_mfa": true }
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS security JSONB NOT NULL DEFAULT '{}'::jsonb;
