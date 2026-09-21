-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — Flexible database system (first-class records, NOT html tables)
-- A "database" has typed properties and rows; rows carry values keyed by
-- property id. Views (table/board/calendar/gallery/list/timeline) are stored
-- configs over the same underlying data.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS databases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A database may be embedded in a page (block of type 'database').
  page_id       UUID REFERENCES pages(id) ON DELETE SET NULL,
  name          TEXT NOT NULL DEFAULT 'Untitled Database',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS databases_workspace_idx ON databases (workspace_id);

-- Property (column) definitions.
CREATE TABLE IF NOT EXISTS database_properties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- text|number|date|date_range|checkbox|select|multi_select|person|url|email|
  -- file|formula|relation|rollup|created_time|updated_time
  type        TEXT NOT NULL,
  -- Type config: select options, formula expr, relation target db, etc.
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  position    TEXT NOT NULL DEFAULT 'n',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS db_props_database_idx ON database_properties (database_id);

-- Records (rows). Values are a JSONB map { property_id: value }.
CREATE TABLE IF NOT EXISTS database_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  values      JSONB NOT NULL DEFAULT '{}'::jsonb,
  position    TEXT NOT NULL DEFAULT 'n',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS db_records_database_idx ON database_records (database_id);
CREATE INDEX IF NOT EXISTS db_records_values_gin ON database_records USING GIN (values);

-- Relations between records (for relation/rollup properties).
CREATE TABLE IF NOT EXISTS record_relations (
  from_record_id UUID NOT NULL REFERENCES database_records(id) ON DELETE CASCADE,
  property_id    UUID NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
  to_record_id   UUID NOT NULL REFERENCES database_records(id) ON DELETE CASCADE,
  PRIMARY KEY (from_record_id, property_id, to_record_id)
);

-- Stored view configs.
CREATE TABLE IF NOT EXISTS database_views (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'Table',
  type        TEXT NOT NULL DEFAULT 'table', -- table|board|calendar|gallery|list|timeline
  config      JSONB NOT NULL DEFAULT '{}'::jsonb, -- filters, sorts, group-by, visible props
  position    TEXT NOT NULL DEFAULT 'n',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS db_views_database_idx ON database_views (database_id);

-- Comments (pages, blocks, records) + mentions.
CREATE TABLE IF NOT EXISTS comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,   -- page|block|record
  target_id   UUID NOT NULL,
  parent_id   UUID REFERENCES comments(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  mentions    UUID[] NOT NULL DEFAULT '{}',
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_target_idx ON comments (target_type, target_id);

-- Full-text search: start with Postgres tsvector (Meilisearch/OpenSearch later).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,''))) STORED;
CREATE INDEX IF NOT EXISTS pages_search_idx ON pages USING GIN (search_tsv);
