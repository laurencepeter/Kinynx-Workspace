-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — data retention policies + legal hold (Enterprise compliance).
-- Retention deletes aged records; an active legal hold suspends deletion.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS retention_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource        TEXT NOT NULL,          -- audit_logs | notifications
  retain_days     INTEGER NOT NULL CHECK (retain_days >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, resource)
);

CREATE TABLE IF NOT EXISTS legal_holds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL DEFAULT '',
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS legal_holds_org_idx ON legal_holds (organization_id, active);
