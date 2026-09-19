-- Auto-ingested plan/spec doc chunks (spec 2026-08-11-auto-ingest-plans-design.md
-- §4/§5). Chunks are DERIVED content: the doc on disk stays authoritative and
-- recall serves POINTERS (path:line + heading trail + excerpt), never bodies.
-- Staleness is doc_sha: a changed doc is delete-and-rechunked atomically per
-- doc. House embedding pattern: DOUBLE PRECISION[] + embedding_model tag —
-- readers filter by tag, writers stamp it (plan 14).
CREATE TABLE IF NOT EXISTS doc_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Plan chunks carry the tracker id (spec §4); NULL for specs and for plan
  -- files the sweep found before any mai_plan registration (late registration
  -- attaches the id on the unchanged path).
  plan_id         uuid REFERENCES plans(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('plan','spec')),
  -- Realpath'd root this doc's path is relative to (plan-20 finding 2481fa65):
  -- the sweep covers EVERY registered repo (projects.path ∪ metadata.repos —
  -- the decision-1a4765b0 union), so identity needs the root. Files inside
  -- projects.path keep a project-root-relative path with repo_root = that root
  -- (byte-identical to single-root behaviour, and joins plans.path); a repo
  -- outside it stores repo-root-relative paths against its own root.
  repo_root       text NOT NULL,
  path            text NOT NULL,   -- relative to repo_root; == plans.path when repo_root is the project root
  doc_sha         text NOT NULL,   -- sha256 of the whole doc at chunking (staleness key)
  chunk_index     int  NOT NULL,
  start_line      int  NOT NULL,   -- 1-based, inclusive
  end_line        int  NOT NULL,   -- 1-based, inclusive
  heading_trail   text NOT NULL,   -- e.g. 'Task 2: Wire it > Step 4: Verify'
  content         text NOT NULL,
  content_hash    text NOT NULL,   -- sha256 of content (chunk-level stability)
  embedding       double precision[],
  embedding_model text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, repo_root, path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_project_path ON doc_chunks(project_id, repo_root, path);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_project_model ON doc_chunks(project_id, embedding_model);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_plan ON doc_chunks(plan_id);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_trgm ON doc_chunks USING gin (content gin_trgm_ops);
