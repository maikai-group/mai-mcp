-- Edges first, then children (pass-6 B4): memory_edges has no FK on
-- from_id/to_id, so dropping the tables would strand `finding -> finding` rows
-- forever; the graph rollback deletes its generic edges before reverting, same
-- precedent.
DELETE FROM memory_edges WHERE from_kind = 'finding' OR to_kind = 'finding';
DROP TABLE IF EXISTS plan_findings;
DROP TABLE IF EXISTS plan_reviews;
DROP TABLE IF EXISTS plans;
