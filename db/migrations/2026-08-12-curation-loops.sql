-- Curation loops (plan 22, spec docs/superpowers/specs/2026-08-12-curation-loops-design.md).
-- Two-tier usage telemetry (§2) + the operator-gated supersede/prune pass (§4).
-- NOTHING here mutates or retires a curated memory: every column is measurement,
-- and every row in memory_citations / curation_candidates is a PROPOSAL until an
-- operator POSTs a verdict. Idempotent throughout (the plan-12 re-gate rule).

-- ---- The §7 legacy baseline, stamped EXACTLY ONCE. A bare
-- `ADD COLUMN IF NOT EXISTS` + `UPDATE ... WHERE curation_baseline_at IS NULL`
-- would re-stamp, on every re-run, every row created since the first run — and
-- silently suppress fresh entries from candidacy. Guarding on the column's
-- absence makes the backfill happen at column-creation time and never again.
-- (Plan 22 ambiguity 2: this replaces the spec's `last_surfaced_at = NOW()`
-- stamp, which does not participate in the age floor and would write a false
-- "last surfaced" date into an operator-facing card field.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'code_decisions'
                    AND column_name = 'curation_baseline_at') THEN
    ALTER TABLE code_decisions ADD COLUMN curation_baseline_at timestamptz;
    UPDATE code_decisions SET curation_baseline_at = NOW();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'lessons'
                    AND column_name = 'curation_baseline_at') THEN
    ALTER TABLE lessons ADD COLUMN curation_baseline_at timestamptz;
    UPDATE lessons SET curation_baseline_at = NOW();
  END IF;
END $$;

-- ---- §2.4 per-entry counters. COUNTS, not scores: nothing selects on them and
-- no code path anywhere decrements them (the no-decay invariant, §6). All
-- NOT NULL DEFAULT 0 so existing rows backfill to "never surfaced, never cited".
ALTER TABLE code_decisions
  ADD COLUMN IF NOT EXISTS surfaced_count      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_surfaced_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cited_count         int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_cited_at       timestamptz,
  -- Parity with lessons, which already has this column. Counting only —
  -- code_decisions.confidence is NEVER written by a citation path (§6/§10.1).
  ADD COLUMN IF NOT EXISTS reinforcement_count int NOT NULL DEFAULT 0;

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS surfaced_count    int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_surfaced_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cited_count       int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_cited_at     timestamptz,
  -- Lessons had NO retirement path — only superseded_by, which needs a
  -- replacement — and §5.1's retire action plus §10.3's every-project
  -- consequence require one. Operator-written only (plan 22 ambiguity 3).
  ADD COLUMN IF NOT EXISTS retired_at        timestamptz,
  ADD COLUMN IF NOT EXISTS retirement_reason text;

-- ---- §2.2 the citation the write-gate validated and used to throw away.
-- Deliberately NOT memory_edges (§2.2): edges are UNIQUE + ON CONFLICT DO
-- UPDATE (deduping erases exactly the count this tier needs), they are the
-- CURATED agent-authored link layer, and they carry no lifecycle state.
CREATE TABLE IF NOT EXISTS memory_citations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  citing_kind       text NOT NULL CHECK (citing_kind IN ('decision','lesson','finding')),
  -- Nullable per spec §2.3. The plan's write path knows the citing id inside
  -- the same transaction as the insert, so it is set at INSERT time and there
  -- is no NULL window at all (plan 22 ambiguity 1).
  citing_id         uuid,
  cited_kind        text NOT NULL CHECK (cited_kind IN ('decision','lesson')),
  cited_id          uuid NOT NULL,
  relation          text NOT NULL CHECK (relation IN ('extends','supersedes','finding_ref')),
  reason            text NOT NULL,
  session_token_id  uuid REFERENCES write_session_tokens(id) ON DELETE SET NULL,
  agent             text,
  -- Supersede proposals live here, UNAPPLIED, until an operator acts (§4).
  status            text NOT NULL DEFAULT 'recorded'
                    CHECK (status IN ('recorded','proposed','applied','dismissed')),
  resolved_at       timestamptz,
  resolved_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_citations_cited ON memory_citations(cited_kind, cited_id);
CREATE INDEX IF NOT EXISTS idx_memory_citations_open
  ON memory_citations(project_id, status) WHERE status = 'proposed';
-- A finding may mention the same UUID in issue and evidence, and
-- mai_finding_update intentionally re-scans old findings. Exactly one
-- load-bearing event per finding/target; the partial index makes concurrent
-- updates safe rather than merely unlikely (decision ba95ae4a).
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_citations_finding_ref
  ON memory_citations(project_id, citing_id, cited_kind, cited_id)
  WHERE citing_kind = 'finding' AND relation = 'finding_ref';

-- ---- §4.2 verdicts and agent proposals. NOT the derived candidate set:
-- telemetry candidates are a query over the counters (§4.3), so this table only
-- ever holds things a human or an agent explicitly said.
CREATE TABLE IF NOT EXISTS curation_candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind   text NOT NULL CHECK (target_kind IN ('decision','lesson')),
  target_id     uuid NOT NULL,
  basis         text NOT NULL CHECK (basis IN ('never-surfaced','never-cited','agent-evidence')),
  evidence      text,
  proposed_by   text,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','kept','applied','dismissed')),
  resolved_at   timestamptz,
  resolved_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Makes a re-proposal on an already-open candidate a NO-OP instead of a queue
-- flood — the same "make the race safe, not merely unlikely" reasoning as
-- plan_reviews UNIQUE (plan_id, pass).
CREATE UNIQUE INDEX IF NOT EXISTS uq_curation_candidates_open
  ON curation_candidates(project_id, target_kind, target_id) WHERE status = 'open';
-- The candidacy query's suppression probe (kept-within-window) hits this.
CREATE INDEX IF NOT EXISTS idx_curation_candidates_target
  ON curation_candidates(project_id, target_kind, target_id, status);
