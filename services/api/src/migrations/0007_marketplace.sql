-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — template marketplace.
-- Templates are portable packages (the same JSON that export/import uses),
-- publishable and downloadable WITHOUT a paid account.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'Other',
  tags         TEXT[] NOT NULL DEFAULT '{}',
  version      TEXT NOT NULL DEFAULT '1.0.0',
  -- The portable package (manifest + content) as JSON.
  package      JSONB NOT NULL,
  downloads    BIGINT NOT NULL DEFAULT 0,
  published    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_tsv   tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || coalesce(category,''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS templates_search_idx ON templates USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS templates_category_idx ON templates (category);

CREATE TABLE IF NOT EXISTS template_ratings (
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, user_id)
);

DO $$ BEGIN
  CREATE TRIGGER trg_templates_updated BEFORE UPDATE ON templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
