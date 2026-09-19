-- Durable project-scoped operator inbox (Plan 43).
CREATE TABLE IF NOT EXISTS operator_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id               uuid REFERENCES plans(id) ON DELETE SET NULL,
  task_key              text NOT NULL CHECK (task_key ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  content_hash          text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source_kind           text NOT NULL CHECK (source_kind IN ('plan','ad_hoc')),
  kind                  text NOT NULL CHECK (kind IN ('blocking','follow_up')),
  title                 text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  instructions          text NOT NULL CHECK (length(btrim(instructions)) BETWEEN 1 AND 4000),
  assigned_by_agent     text NOT NULL,
  assigned_by_session   text NOT NULL,
  sort_order            int NOT NULL CHECK (sort_order BETWEEN 0 AND 99),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','completed','dismissed')),
  resolution_note       text,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_tasks_resolution_state CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolution_note IS NULL)
    OR (status = 'completed' AND resolved_at IS NOT NULL)
    OR (status = 'dismissed' AND resolved_at IS NOT NULL
        AND resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_plan_key
  ON operator_tasks(plan_id, task_key) WHERE source_kind = 'plan' AND plan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_adhoc_key
  ON operator_tasks(project_id, assigned_by_session, task_key) WHERE source_kind = 'ad_hoc';
CREATE INDEX IF NOT EXISTS operator_tasks_inbox
  ON operator_tasks(project_id, status, kind, created_at DESC, id);
CREATE INDEX IF NOT EXISTS operator_tasks_plan
  ON operator_tasks(plan_id, status) WHERE plan_id IS NOT NULL;
