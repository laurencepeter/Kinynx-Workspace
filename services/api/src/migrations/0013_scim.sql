-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — SCIM 2.0 inbound provisioning (Enterprise `scim`).
-- Each org has one SCIM bearer token (stored hashed); the IdP presents it to
-- push users/groups to /scim/v2/*.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS scim_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_scim_token_idx
  ON organizations (scim_token_hash) WHERE scim_token_hash IS NOT NULL;
