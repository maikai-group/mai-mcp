-- Graduation (plan 27, spec docs/superpowers/specs/2026-08-14-plan-27-design.md §3).
-- Two changes, both additive, both idempotent (the plan-12 re-gate rule):
--
-- 1. lessons.relearned_count — the DEDICATED graduation signal (decision
--    04c4848b). NOT reinforcement_count: plan 22 made citation reinforcement
--    bump that too, merging "relearned" with "cited" — exactly the distinction
--    graduation depends on. Bumped ONLY by the dedup path; no code path
--    decrements it (the plan-22 no-decay invariant extends here).
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS relearned_count int NOT NULL DEFAULT 0;

-- 2. basis gains 'graduate'. Graduate rows are VERDICTS only ('applied' /
--    'dismissed', written by curationPromote/curationReject) — candidacy stays
--    a computed query, so this table keeps holding only things a human or an
--    agent explicitly said (the plan-22 §4.2 rule). DROP+ADD is the idempotent
--    CHECK-widening form; the constraint name was probed live on 54334.
ALTER TABLE curation_candidates
  DROP CONSTRAINT IF EXISTS curation_candidates_basis_check;
ALTER TABLE curation_candidates
  ADD CONSTRAINT curation_candidates_basis_check
  CHECK (basis IN ('never-surfaced','never-cited','agent-evidence','graduate'));
