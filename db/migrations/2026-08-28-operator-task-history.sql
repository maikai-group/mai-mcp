-- Durable terminal-history tombstones (Plan 44).
ALTER TABLE operator_tasks
  ADD COLUMN IF NOT EXISTS source_plan_slug text,
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;

UPDATE operator_tasks task
   SET source_plan_slug = plan.slug
  FROM plans plan
 WHERE task.plan_id = plan.id
   AND task.source_kind = 'plan'
   AND task.source_plan_slug IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM operator_tasks
     WHERE source_kind = 'plan' AND source_plan_slug IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot recover source identity for an orphaned plan task';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'operator_tasks_source_identity'
       AND conrelid = 'operator_tasks'::regclass
  ) THEN
    ALTER TABLE operator_tasks
      ADD CONSTRAINT operator_tasks_source_identity CHECK (
        (source_kind = 'plan' AND source_plan_slug IS NOT NULL)
        OR (source_kind = 'ad_hoc' AND source_plan_slug IS NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'operator_tasks_removed_terminal'
       AND conrelid = 'operator_tasks'::regclass
  ) THEN
    ALTER TABLE operator_tasks
      ADD CONSTRAINT operator_tasks_removed_terminal CHECK (
        removed_at IS NULL OR status IN ('completed','dismissed')
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_plan_source_key
  ON operator_tasks(project_id, source_plan_slug, task_key)
  WHERE source_kind = 'plan' AND source_plan_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS operator_tasks_visible
  ON operator_tasks(
    project_id, status, plan_id, resolved_at DESC NULLS LAST,
    kind, sort_order, created_at, id
  )
  WHERE removed_at IS NULL;
