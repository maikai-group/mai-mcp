-- Git semantic evidence layer v1 (spec 2026-07-09): richer commit facts +
-- per-file stats. Additive only. Existing rows backfill on the next sync
-- (the sync upsert switches to DO UPDATE). No patch bytes are stored anywhere.
ALTER TABLE code_commits
  ADD COLUMN IF NOT EXISTS parents text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS branch_observed text,
  ADD COLUMN IF NOT EXISTS repo_path text;

CREATE TABLE IF NOT EXISTS commit_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_id uuid NOT NULL REFERENCES code_commits(id) ON DELETE CASCADE,
  path text NOT NULL,
  status text NOT NULL CHECK (status IN ('added', 'modified', 'deleted', 'renamed')),
  old_path text,
  additions integer,
  deletions integer,
  is_binary boolean NOT NULL DEFAULT false,
  UNIQUE (commit_id, path)
);

CREATE INDEX IF NOT EXISTS idx_commit_files_project_path ON commit_files (project_id, path);
CREATE INDEX IF NOT EXISTS idx_commit_files_commit ON commit_files (commit_id);
