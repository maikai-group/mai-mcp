-- Preserve Git evidence and old-SHA lookup across sanitizing history rewrites.
-- A NULL new_hash is an intentional tombstone for a commit pruned because its
-- entire diff was removed. memory_edges keep pointing at the stable commit_id.
CREATE TABLE IF NOT EXISTS git_history_rewrites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_id UUID NOT NULL REFERENCES code_commits(id) ON DELETE CASCADE,
  old_hash VARCHAR(40) NOT NULL,
  new_hash VARCHAR(40),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (old_hash ~ '^[0-9a-f]{40}$'),
  CHECK (new_hash IS NULL OR new_hash ~ '^[0-9a-f]{40}$'),
  CHECK (new_hash IS NULL OR new_hash <> old_hash),
  UNIQUE(project_id, old_hash)
);

CREATE INDEX IF NOT EXISTS idx_git_history_rewrites_commit
  ON git_history_rewrites(commit_id);
CREATE INDEX IF NOT EXISTS idx_git_history_rewrites_new_hash
  ON git_history_rewrites(project_id, new_hash)
  WHERE new_hash IS NOT NULL;
