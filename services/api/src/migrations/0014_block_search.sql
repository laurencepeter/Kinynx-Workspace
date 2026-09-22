-- ════════════════════════════════════════════════════════════════════════════
-- Kinynx — full-text index over block content (search page bodies, not just titles).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content->>'text','') || ' ' || coalesce(content->>'code',''))
  ) STORED;
CREATE INDEX IF NOT EXISTS blocks_search_idx ON blocks USING GIN (search_tsv);
