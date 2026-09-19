DROP TABLE IF EXISTS commit_files;
ALTER TABLE code_commits
  DROP COLUMN IF EXISTS parents,
  DROP COLUMN IF EXISTS body,
  DROP COLUMN IF EXISTS committed_at,
  DROP COLUMN IF EXISTS branch_observed,
  DROP COLUMN IF EXISTS repo_path;
