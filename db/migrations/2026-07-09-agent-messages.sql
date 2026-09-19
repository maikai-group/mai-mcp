-- Agent message board v1 (spec 2026-07-09): project-scoped typed coordination
-- threads, distinct from curated memory by construction. Idempotent posting via
-- the partial unique index (per-process author_session + body hash).
CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES agent_messages(id) ON DELETE CASCADE,
  author_agent text NOT NULL,
  author_session text,
  type text NOT NULL CHECK (type IN ('note', 'question', 'answer', 'todo', 'handoff', 'finding')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'superseded', 'stale')),
  body text NOT NULL,
  refs jsonb NOT NULL DEFAULT '[]',
  resolved_by uuid REFERENCES agent_messages(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_idempotent
  ON agent_messages (author_session, md5(body)) WHERE author_session IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_messages_open
  ON agent_messages (project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages (thread_id);
