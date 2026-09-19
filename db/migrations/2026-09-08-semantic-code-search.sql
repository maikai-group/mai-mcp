BEGIN;
CREATE TABLE IF NOT EXISTS graph_code_policy (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'local'
    CHECK (provider IN ('off','local','openai','voyage')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  consent_version text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider IN ('off','local') AND consent_version IS NULL)
    OR (provider IN ('openai','voyage')
      AND consent_version IS NOT NULL
      AND consent_version = 'code-and-lessons/1'))
);
CREATE TABLE IF NOT EXISTS graph_code_embeddings (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  identity char(64) NOT NULL CHECK (identity ~ '^[0-9a-f]{64}$'),
  model text NOT NULL,
  document_version text NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  source_hash char(64),
  source_evidence jsonb,
  document_mode text NOT NULL CHECK (document_mode IN ('declaration','metadata')),
  embedding double precision[] NOT NULL,
  cue_version text,
  cue_fingerprint char(64),
  cue_embedding double precision[],
  CHECK ((cue_version IS NULL AND cue_fingerprint IS NULL AND cue_embedding IS NULL)
    OR (cue_version IS NOT NULL AND cue_fingerprint IS NOT NULL AND cue_embedding IS NOT NULL
      AND cue_fingerprint ~ '^[0-9a-f]{64}$' AND cardinality(cue_embedding)=384)),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, identity, model, document_version),
  CHECK (cardinality(embedding) IN (384,1024,1536))
);
CREATE TABLE IF NOT EXISTS graph_code_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  policy_revision integer NOT NULL,
  model text NOT NULL,
  state text NOT NULL CHECK (state IN
    ('running','completed','partial','cancelled','failed')),
  scanned integer NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  written integer NOT NULL DEFAULT 0 CHECK (written >= 0),
  reused integer NOT NULL DEFAULT 0 CHECK (reused >= 0),
  skipped integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  cancel_requested boolean NOT NULL DEFAULT false,
  reason text,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_code_jobs_running
  ON graph_code_jobs(project_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS graph_code_jobs_recent
  ON graph_code_jobs(project_id, created_at DESC, id);
COMMIT;
