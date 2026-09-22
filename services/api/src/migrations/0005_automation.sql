-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — integrations framework + automation engine.
-- WHEN <trigger> [matches filter] THEN <actions>.
-- ════════════════════════════════════════════════════════════════════════════

-- Integration instances (a configured connection to an external service).
CREATE TABLE IF NOT EXISTS integrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,     -- webhook | slack | discord | github | gitlab | teams | ...
  name          TEXT NOT NULL,
  -- Connection config (incoming webhook URL, tokens…). Secrets: encrypt at rest
  -- in production; here stored as JSONB and never returned in list responses.
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integrations_ws_idx ON integrations (workspace_id);

-- Automations: a trigger + an ordered list of actions.
CREATE TABLE IF NOT EXISTS automations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_type   TEXT NOT NULL,   -- page.created | record.created | record.updated |
                                  -- comment.added | task.completed | invite.accepted
  trigger_filter JSONB NOT NULL DEFAULT '{}'::jsonb, -- simple equality match on event.data
  actions        JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ type, config }]
  -- Secret used to sign outgoing webhooks (HMAC-SHA256).
  secret         TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automations_ws_trigger_idx ON automations (workspace_id, trigger_type, enabled);

-- Execution log.
CREATE TABLE IF NOT EXISTS automation_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,   -- success | error | skipped
  event         JSONB NOT NULL DEFAULT '{}'::jsonb,
  result        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_runs_idx ON automation_runs (automation_id, created_at DESC);
