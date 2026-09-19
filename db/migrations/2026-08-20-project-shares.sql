-- Cross-project references (plan 31, spec docs/superpowers/specs/2026-08-18-cross-project-references-design.md).
-- Two-key shares: a row here is the GRANT half; the target's MAI_LINKED_PROJECTS
-- env is the other half. Rows are read-only toward the source; grant/revoke are
-- operator surfaces only (CLI/dashboard) — no agent-facing tool writes here.
-- Idempotent throughout (the plan-12 re-gate rule).

CREATE TABLE IF NOT EXISTS project_shares (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_kind      text NOT NULL CHECK (artifact_kind IN ('decision','doc','handoff','idea')),
  artifact_id        uuid,           -- decision | handoff | idea
  artifact_ref       jsonb,          -- doc: {"repo_root":..., "path":..., "heading"?:...}
  snapshot           jsonb NOT NULL, -- {"headline","body","source_slug","detail"}
  content_hash       text NOT NULL,  -- sha256 over canonical body fields (doc: the doc_sha)
  snapshot_at        timestamptz NOT NULL DEFAULT now(),
  note               text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at         timestamptz,
  revoked_reason     text,
  embedding          double precision[],
  embedding_model    text,
  created_via        text NOT NULL CHECK (created_via IN ('cli','dashboard')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (source_project_id <> target_project_id),
  CHECK ((artifact_kind = 'doc') = (artifact_ref IS NOT NULL)),
  CHECK ((artifact_kind <> 'doc') = (artifact_id IS NOT NULL)),
  CHECK (status = 'active' OR revoked_reason IS NOT NULL)
);

-- One ACTIVE share per (source, target, artifact); revoked history accumulates.
CREATE UNIQUE INDEX IF NOT EXISTS project_shares_active_uniq ON project_shares
  (source_project_id, target_project_id, artifact_kind,
   coalesce(artifact_id::text, artifact_ref::text))
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS project_shares_target_idx ON project_shares
  (target_project_id) WHERE status = 'active';

-- Audit trail. Deliberately NO foreign keys and denormalized stable project
-- UUIDs plus event-time slugs/headline:
-- deleting a project cascades its project_shares rows away, but the record of
-- what was shared, to whom, and when must survive (spec §4.2).
CREATE TABLE IF NOT EXISTS share_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id      uuid NOT NULL,
  source_project_id uuid NOT NULL, -- stable audit identity; deliberately NO FK
  target_project_id uuid NOT NULL, -- stable audit identity; deliberately NO FK
  event         text NOT NULL CHECK (event IN ('grant','revoke','regrant')),
  source_slug   text NOT NULL,
  target_slug   text NOT NULL,
  artifact_kind text NOT NULL,
  headline      text NOT NULL,
  actor_surface text NOT NULL CHECK (actor_surface IN ('cli','dashboard')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_events_share_idx ON share_events (share_id);
CREATE INDEX IF NOT EXISTS share_events_source_time_idx ON share_events
  (source_project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS share_events_target_time_idx ON share_events
  (target_project_id, created_at DESC, id DESC);
