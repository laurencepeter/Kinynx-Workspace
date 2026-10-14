-- Track who added and who last edited each block, so clients can attribute
-- contributions (colour-coded per user) on shared pages.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
