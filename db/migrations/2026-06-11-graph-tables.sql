-- mai-graph Plan 4a (spec: docs/superpowers/specs/2026-06-11-mai-graph-design.md §2).
-- Graph storage with OPEN kind/relation vocabularies (TEXT, no CHECK enums —
-- compile-time safety lives in src/graph/registry.ts; prose extractor lands
-- later with zero migration). memory_edges relaxed to the same approach:
-- from_kind/to_kind/relation CHECKs dropped ('graph_node' arrives as a kind),
-- plus a confidence column so machine-materialized links (the decisions→file
-- linker writes 'inferred') are distinguishable from agent-asserted ones.

CREATE TABLE IF NOT EXISTS graph_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- open vocabulary, per-extractor registry
  name TEXT NOT NULL,
  qualified_name TEXT,            -- e.g. app/src/lib/save.ts#saveWorkout
  file_path TEXT,
  line INT,
  lang VARCHAR(24),
  signature TEXT,
  content_hash VARCHAR(64),       -- staleness: sha256 of the defining file at extraction
  commit_sha VARCHAR(40),         -- staleness: repo HEAD at extraction
  extracted_by VARCHAR(32) NOT NULL,
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  UNIQUE(project_id, kind, qualified_name)
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_extractor ON graph_nodes(project_id, extracted_by);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_name_trgm ON graph_nodes USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_qname_trgm ON graph_nodes USING gin (qualified_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS graph_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_node UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  to_node UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,         -- open vocabulary, per-extractor registry
  confidence VARCHAR(16) NOT NULL DEFAULT 'extracted',  -- extracted | inferred | behavioral
  weight REAL DEFAULT 1.0,
  metadata JSONB DEFAULT '{}',
  UNIQUE(project_id, from_node, to_node, relation)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_relation ON graph_edges(project_id, relation);

-- memory_edges → open vocabulary + machine-link confidence (spec §2 brain join).
ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS memory_edges_from_kind_check;
ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS memory_edges_to_kind_check;
ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS memory_edges_relation_check;
ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'asserted';
