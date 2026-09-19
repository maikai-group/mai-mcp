-- conductor-machine-contract/2 (plan ea1965f1): append-only run receipts +
-- content-addressed artifacts for external machine consumers (M-AI5 conductor).
--
-- run_receipts.plan_id is SET NULL on plan deletion: a receipt is evidence that
-- work happened and what it cost — it outlives the plan (code_findings
-- precedent). Rows are never updated or deleted by application code.
-- kind is a consumer-owned bounded token, NOT an enum: mai-mcp validates shape
-- boundaries, never consumer semantics (the /1 draft's enum caused a
-- consumer-vocabulary mismatch the moment the consumer added a kind).
CREATE TABLE IF NOT EXISTS run_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id             uuid REFERENCES plans(id) ON DELETE SET NULL,
  receipt_key         text NOT NULL CHECK (length(receipt_key) BETWEEN 1 AND 256),
  kind                text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_-]{0,63}$'),
  cycle_id            text NOT NULL CHECK (length(cycle_id) BETWEEN 1 AND 128),
  pass                int CHECK (pass IS NULL OR pass >= 1),
  schema_version      text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 64),
  payload             jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256      char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_agent    text NOT NULL,
  created_by_session  text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_receipts_idempotency UNIQUE (project_id, receipt_key)
);

CREATE INDEX IF NOT EXISTS run_receipts_plan
  ON run_receipts(plan_id, created_at, id) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_receipts_cycle
  ON run_receipts(project_id, cycle_id, created_at, id);

-- Content-addressed artifact store: identity IS sha256(utf8 bytes), so any
-- client computes the address independently — no cross-repo ID derivation.
-- Immutable and permanent: no release/delete operation exists in contract /2
-- (destructive authority stays out of the ungated tracker family; retention is
-- an operator concern).
CREATE TABLE IF NOT EXISTS run_artifacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_-]{0,63}$'),
  sha256              char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length         int NOT NULL CHECK (byte_length > 0),
  content             bytea NOT NULL,
  created_by_agent    text NOT NULL,
  created_by_session  text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_artifacts_identity UNIQUE (project_id, sha256)
);
