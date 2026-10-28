-- ════════════════════════════════════════════════════════════════════════════
-- Workflows, progress tracking, dashboards & workspace customization.
--   • record_events — append-only change log per record (time-series source for
--     burn-up, throughput, lead time, activity feeds). record_id carries no FK so
--     history survives record deletion.
--   • workflows     — one per database: ordered stages over a select property,
--     stage categories (todo/active/done), allowed transitions, WIP limits.
--   • dashboards    — saved chart/table/KPI widget layouts over databases.
--   • workspaces.settings — validated appearance & behaviour preferences.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS record_events (
  id           BIGSERIAL PRIMARY KEY,
  database_id  UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id    UUID NOT NULL,
  kind         TEXT NOT NULL,          -- created|updated|stage_changed|deleted
  property_id  UUID,
  from_value   JSONB,
  to_value     JSONB,
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_events_db_time_idx ON record_events (database_id, created_at);
CREATE INDEX IF NOT EXISTS record_events_record_idx ON record_events (record_id, created_at);

CREATE TABLE IF NOT EXISTS workflows (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id        UUID NOT NULL UNIQUE REFERENCES databases(id) ON DELETE CASCADE,
  status_property_id UUID NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
  -- Optional date property used for "overdue" in progress reports.
  due_property_id    UUID REFERENCES database_properties(id) ON DELETE SET NULL,
  -- [{ name, color, category: 'todo'|'active'|'done', wip_limit }]
  stages             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- { "<from stage>": ["<to stage>", ...] }; a missing key allows any move.
  transitions        JSONB NOT NULL DEFAULT '{}'::jsonb,
  enforce            BOOLEAN NOT NULL DEFAULT true,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  widgets      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboards_workspace_idx ON dashboards (workspace_id);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: seed a "created" event for every existing record so progress
-- charts have a baseline (values reflect the record as of this migration).
INSERT INTO record_events (database_id, record_id, kind, to_value, actor_id, created_at)
SELECT database_id, id, 'created', values, created_by, created_at FROM database_records;
