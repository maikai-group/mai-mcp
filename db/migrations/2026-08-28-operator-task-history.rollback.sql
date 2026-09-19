-- Bounded rollback: remove only Plan 44 history tombstones.
DROP INDEX IF EXISTS operator_tasks_visible;
DROP INDEX IF EXISTS operator_tasks_plan_source_key;
ALTER TABLE operator_tasks
  DROP CONSTRAINT IF EXISTS operator_tasks_removed_terminal;
ALTER TABLE operator_tasks
  DROP CONSTRAINT IF EXISTS operator_tasks_source_identity;
ALTER TABLE operator_tasks
  DROP COLUMN IF EXISTS removed_at,
  DROP COLUMN IF EXISTS source_plan_slug;
