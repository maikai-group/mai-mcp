-- Add the embedding column to code_decisions. Plan 1's decisionAdd/decisionsSimilar
-- (forked from kai brain2) store + read a DOUBLE PRECISION[] embedding here, but the
-- v1 baseline schema omitted the column. Idempotent so it is safe on fresh installs.
ALTER TABLE code_decisions ADD COLUMN IF NOT EXISTS embedding DOUBLE PRECISION[];
