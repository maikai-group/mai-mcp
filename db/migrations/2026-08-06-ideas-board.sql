-- Ideas/roadmap board (plan 11, spec 2026-08-06 §A). Per-project boards plus one
-- global board (project_id IS NULL). No CHECK constraints on status/priority —
-- enforced in code, matching the code_decisions.source precedent.
CREATE TABLE IF NOT EXISTS ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global board
  title VARCHAR(200) NOT NULL,
  detail TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'idea',      -- idea | planned | building | shipped | dropped
  priority VARCHAR(16) NOT NULL DEFAULT 'someday', -- now | next | later | someday
  sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,  -- fractional ranking; midpoint insertion, no renumbering
  source VARCHAR(32) NOT NULL DEFAULT 'agent-inferred',  -- user | agent-inferred (same vocabulary family as decisions)
  evidence TEXT,                                   -- required on agent moves; the plan/commit/decision cited
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ideas_board ON ideas (project_id, status, priority, sort_order);
