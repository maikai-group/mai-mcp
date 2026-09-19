BEGIN;
CREATE TABLE IF NOT EXISTS graph_lesson_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  identity char(64) NOT NULL CHECK (identity ~ '^[0-9a-f]{64}$'),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  kind text NOT NULL,
  qualified_name text NOT NULL,
  extracted_by text NOT NULL,
  physical_path text,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  attached_at timestamptz NOT NULL DEFAULT now(),
  detached_at timestamptz,
  UNIQUE(project_id, identity, lesson_id)
);
CREATE INDEX IF NOT EXISTS graph_lesson_attachments_active
  ON graph_lesson_attachments(project_id, identity)
  WHERE detached_at IS NULL;
CREATE TABLE IF NOT EXISTS graph_lesson_attachment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid NOT NULL REFERENCES graph_lesson_attachments(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('attach','detach')),
  actor_surface text NOT NULL CHECK (actor_surface IN ('mcp','cli','dashboard')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  cited_lesson_id uuid,
  citation_how text,
  session_token_id uuid REFERENCES write_session_tokens(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_surface = 'mcp' AND cited_lesson_id IS NOT NULL
    AND citation_how IS NOT NULL AND length(btrim(citation_how)) BETWEEN 1 AND 1000)
    OR (actor_surface IN ('cli','dashboard') AND cited_lesson_id IS NULL
      AND citation_how IS NULL AND session_token_id IS NULL))
);
CREATE INDEX IF NOT EXISTS graph_lesson_attachment_events_history
  ON graph_lesson_attachment_events(project_id, attachment_id, created_at, id);
COMMIT;
