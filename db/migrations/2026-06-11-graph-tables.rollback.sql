-- Rollback for 2026-06-11-graph-tables.sql. DESTRUCTIVE: drops the entire graph
-- and deletes memory_edges rows that violate the restored closed vocabularies.
DROP TABLE IF EXISTS graph_edges;
DROP TABLE IF EXISTS graph_nodes;
DELETE FROM memory_edges
 WHERE from_kind NOT IN ('decision','lesson','session','topic')
    OR to_kind   NOT IN ('decision','lesson','session','topic')
    OR relation  NOT IN ('relates_to','caused_by','fixed_by','same_flaw_as');
ALTER TABLE memory_edges DROP COLUMN IF EXISTS confidence;
ALTER TABLE memory_edges ADD CONSTRAINT memory_edges_from_kind_check
  CHECK (from_kind IN ('decision','lesson','session','topic'));
ALTER TABLE memory_edges ADD CONSTRAINT memory_edges_to_kind_check
  CHECK (to_kind IN ('decision','lesson','session','topic'));
ALTER TABLE memory_edges ADD CONSTRAINT memory_edges_relation_check
  CHECK (relation IN ('relates_to','caused_by','fixed_by','same_flaw_as'));
