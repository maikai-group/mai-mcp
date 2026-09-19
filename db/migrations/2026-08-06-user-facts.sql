-- Global user-facts layer (plan 11, spec 2026-08-06 §B). No project_id BY
-- CONSTRUCTION — facts describe the operator, not a project; the global layer is
-- the sanctioned cross-project mechanism (decision 6fdeff6c). Category is
-- enforced in code, matching the code_decisions.source precedent.
CREATE TABLE IF NOT EXISTS user_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(16) NOT NULL,                   -- identity | preference | workflow | tooling
  fact VARCHAR(300) NOT NULL,                      -- one sentence
  detail TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'agent-inferred', -- agent-inferred | user-approved
  evidence TEXT NOT NULL,                          -- where the agent learned it
  retracted_at TIMESTAMPTZ,
  retraction_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
