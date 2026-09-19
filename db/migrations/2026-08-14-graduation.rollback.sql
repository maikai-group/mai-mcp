-- Rollback: graduate verdict rows must go before the CHECK re-narrows, or the
-- ADD CONSTRAINT fails on existing rows.
DELETE FROM curation_candidates WHERE basis = 'graduate';
ALTER TABLE curation_candidates
  DROP CONSTRAINT IF EXISTS curation_candidates_basis_check;
ALTER TABLE curation_candidates
  ADD CONSTRAINT curation_candidates_basis_check
  CHECK (basis IN ('never-surfaced','never-cited','agent-evidence'));
ALTER TABLE lessons DROP COLUMN IF EXISTS relearned_count;
