-- Code-review findings (plan 24, spec docs/superpowers/specs/2026-08-13-skills-suite-design.md §8).
-- Separate from plan_findings because that table requires review_id NOT NULL ->
-- plan_reviews, and a review row requires a pass number and an approved/blocked
-- verdict. A code review of one task is neither: filing it there would consume a
-- plan review pass and issue a verdict on the plan. Here the plan link is
-- OPTIONAL, which is the whole fix.
CREATE TABLE IF NOT EXISTS code_findings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- NULLABLE + SET NULL: an ad-hoc diff review has no plan, and deleting a plan
  -- must not delete the record that a defect existed in the code.
  plan_id           uuid REFERENCES plans(id) ON DELETE SET NULL,
  base_sha          text NOT NULL,
  head_sha          text NOT NULL,
  reviewer_agent    text NOT NULL,
  ref               text,
  severity          text NOT NULL CHECK (severity IN ('blocker','warning','note')),
  title             text NOT NULL,
  location          text NOT NULL,
  issue             text NOT NULL,
  evidence          text NOT NULL,
  fix               text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','fixed','disputed','accepted-risk')),
  resolution_note   text,
  resolved_at       timestamptz,
  resolved_by_agent text,
  embedding         double precision[],
  embedding_model   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Mirrors plan_findings_closed_needs_note (db/schema.sql:222-224). The CLI
  -- checks this too, but that check is ERGONOMICS — it exists so the caller
  -- gets a readable message instead of a raw 23514. The constraint is the
  -- BACKSTOP, and it has to survive a direct psql write, a second writer, or a
  -- bug in the CLI. Shipping the ergonomics without the backstop is how a
  -- closed finding ends up with no recorded reason.
  CONSTRAINT code_findings_closed_needs_note
    CHECK (status = 'open' OR resolution_note IS NOT NULL)
);
-- The handoff read: this project's findings, newest first, optionally by plan.
CREATE INDEX IF NOT EXISTS idx_code_findings_project ON code_findings(project_id, created_at DESC);
-- The plan-scoped read (spec §8.1: plan-linked code findings join the handoff).
CREATE INDEX IF NOT EXISTS idx_code_findings_plan ON code_findings(plan_id) WHERE plan_id IS NOT NULL;
-- similar_to recall is a trigram match on title, exactly as plan_findings does it.
CREATE INDEX IF NOT EXISTS idx_code_findings_title_trgm ON code_findings USING gin (title gin_trgm_ops);
-- The open-work read.
CREATE INDEX IF NOT EXISTS idx_code_findings_status ON code_findings(project_id, status);
-- Mirrors idx_plan_findings_project_model (db/schema.sql:228). This is the one
-- index serving the two sites plan 24 makes load-bearing: :1065 filters
-- (project_id, embedding_model = $2) and :1108 filters
-- (project_id, embedding_model IS DISTINCT FROM $2). Without it both halves of
-- the widened semantic path sequential-scan, and ambiguity 6 guarantees this
-- table is populated with vectors, so the scan grows with the store.
CREATE INDEX IF NOT EXISTS idx_code_findings_project_model ON code_findings(project_id, embedding_model);
