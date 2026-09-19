-- Tables first, then the added columns. No memory_edges DELETE is needed here
-- (contrast 2026-08-09-plan-findings.rollback.sql, which must clear edges
-- first): this build introduces NO memory_edges kind — the citation layer is
-- deliberately a separate table, not the curated edge layer (spec §2.2) — so
-- nothing can be stranded. Counters and verdicts are both re-derivable: the
-- counters restart at zero and every applied verdict is already reflected in
-- the entry's own still_valid / retired_at state.
DROP TABLE IF EXISTS curation_candidates;
DROP TABLE IF EXISTS memory_citations;
ALTER TABLE lessons
  DROP COLUMN IF EXISTS retirement_reason,
  DROP COLUMN IF EXISTS retired_at,
  DROP COLUMN IF EXISTS curation_baseline_at,
  DROP COLUMN IF EXISTS last_cited_at,
  DROP COLUMN IF EXISTS cited_count,
  DROP COLUMN IF EXISTS last_surfaced_at,
  DROP COLUMN IF EXISTS surfaced_count;
ALTER TABLE code_decisions
  DROP COLUMN IF EXISTS curation_baseline_at,
  DROP COLUMN IF EXISTS reinforcement_count,
  DROP COLUMN IF EXISTS last_cited_at,
  DROP COLUMN IF EXISTS cited_count,
  DROP COLUMN IF EXISTS last_surfaced_at,
  DROP COLUMN IF EXISTS surfaced_count;
