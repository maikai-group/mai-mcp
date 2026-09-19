-- Plan findings tracker (spec 2026-08-09 §5). Reviews and their findings become
-- first-class records: UUID-identified, status-carrying, recurrence-linkable.
-- The plan .md stays authoritative for CONTENT; `plans` is identity + state.
CREATE TABLE IF NOT EXISTS plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug         text NOT NULL,
  path         text NOT NULL,
  title        text NOT NULL,
  current_sha  text,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','reviewing','approved','executing','executed','abandoned')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_plans_project_path ON plans(project_id, path);

CREATE TABLE IF NOT EXISTS plan_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  pass             int  NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('author','blind')),
  reviewer_agent   text NOT NULL,
  reviewer_session text,
  verdict          text NOT NULL CHECK (verdict IN ('approved','blocked')),
  plan_sha         text,
  -- NOT NULL (pass-4 B2): the synthesis is the most valuable output of a
  -- review (spec §7) — nullable here recreated the exact optional-loss failure
  -- R3 closes for evidence/fix.
  synthesis        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Makes concurrent blind reviewers SAFE, not merely unlikely to collide:
  -- a genuine race raises 23505 and the tool retries (spec §5).
  UNIQUE (plan_id, pass)
);

CREATE TABLE IF NOT EXISTS plan_findings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id         uuid NOT NULL REFERENCES plan_reviews(id) ON DELETE CASCADE,
  plan_id           uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  -- Denormalised so the project-wide similar_to scan filters without joining
  -- plans — mirrors how code_decisions scopes its semantic scan.
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ref               text,
  severity          text NOT NULL CHECK (severity IN ('blocker','warning','note')),
  title             text NOT NULL,
  location          text NOT NULL,
  issue             text NOT NULL,
  -- NOT NULL on purpose (spec §1): decision 4f348134 recorded a rejection count
  -- with alternatives_considered empty, and the reasoning is unreconstructable.
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
  CONSTRAINT plan_findings_closed_needs_note
    CHECK (status = 'open' OR resolution_note IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_plan_findings_plan ON plan_findings(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_findings_project_sev ON plan_findings(project_id, severity);
CREATE INDEX IF NOT EXISTS idx_plan_findings_project_model ON plan_findings(project_id, embedding_model);
CREATE INDEX IF NOT EXISTS idx_plan_findings_trgm ON plan_findings USING gin (title gin_trgm_ops);
