-- Parallel-agent path claims (decision b0fc1969): path-globs + intent line per
-- claim, warn-never-block, heartbeat-driven TTL. A table (not board messages):
-- claims need queryability + expiry, not conversation. server_pid powers the
-- pre-edit hook's own-session suppression (advisory only; 0 = unknown).
CREATE TABLE IF NOT EXISTS agent_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_root text NOT NULL,
  author_agent text NOT NULL,
  author_session text NOT NULL,
  server_pid integer NOT NULL DEFAULT 0,
  paths jsonb NOT NULL,
  intent text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

-- Retried claims are idempotent per process (the board's proven pattern).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_claims_idempotent
  ON agent_claims (author_session, md5(intent), md5(paths::text)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agent_claims_active
  ON agent_claims (project_id, status, last_heartbeat_at DESC);
