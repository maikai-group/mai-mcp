-- ============================================================
-- mai_brain — schema v1 (Plan 1: Foundation + Brain Core)
-- Target: mai_brain on 127.0.0.1:54334 (container mai-brain-pg)
-- Origin: forked from the Mai Group's predecessor memory server (private).
-- NO agent_role anywhere. NO task-lifecycle / tooling / patterns tables.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----- projects: top-level namespace. metadata.repos = ["<abs path>", ...] -----
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  path TEXT,
  description TEXT,
  tech_stack TEXT[] DEFAULT '{}',
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  total_sessions INT DEFAULT 0,
  total_commits INT DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

-- ----- code_sessions: populated by Plan 2 passive capture. In schema now
-- so code_decisions.session_id has its FK target from day one. -----
CREATE TABLE code_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_session_id VARCHAR(255) UNIQUE,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INT,
  model VARCHAR(64),
  summary TEXT,
  objectives TEXT[],
  outcomes TEXT[],
  message_count INT DEFAULT 0,
  tool_calls INT DEFAULT 0,
  files_read INT DEFAULT 0,
  files_written INT DEFAULT 0,
  files_edited INT DEFAULT 0,
  commits INT DEFAULT 0,
  lines_added INT DEFAULT 0,
  lines_removed INT DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);
CREATE INDEX idx_code_sessions_project ON code_sessions(project_id);
CREATE INDEX idx_code_sessions_started ON code_sessions(started_at DESC);

-- ----- code_commits: populated by Plan 2 hooks. -----
CREATE TABLE code_commits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES code_sessions(id) ON DELETE SET NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_hash VARCHAR(40) NOT NULL,
  message TEXT NOT NULL,
  files_changed TEXT[],
  lines_added INT DEFAULT 0,
  lines_removed INT DEFAULT 0,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  commit_type VARCHAR(20),
  scope VARCHAR(100),
  breaking_change BOOLEAN DEFAULT false,
  author VARCHAR(100),
  co_authors TEXT[] DEFAULT '{}',
  UNIQUE(project_id, commit_hash)
);
CREATE INDEX idx_commits_project ON code_commits(project_id);

-- ----- git_history_rewrites: durable old-SHA resolution across sanitizing
-- history rewrites. commit_id is stable even when a reachable commit receives
-- a new hash; new_hash NULL records a deliberately pruned commit tombstone.
-- Keeping this separate from code_commits preserves UUID-based memory_edges
-- while letting mai_git_show resolve prose and findings that cite an old SHA.
CREATE TABLE git_history_rewrites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_id UUID NOT NULL REFERENCES code_commits(id) ON DELETE CASCADE,
  old_hash VARCHAR(40) NOT NULL,
  new_hash VARCHAR(40),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (old_hash ~ '^[0-9a-f]{40}$'),
  CHECK (new_hash IS NULL OR new_hash ~ '^[0-9a-f]{40}$'),
  CHECK (new_hash IS NULL OR new_hash <> old_hash),
  UNIQUE(project_id, old_hash)
);
CREATE INDEX idx_git_history_rewrites_commit ON git_history_rewrites(commit_id);
CREATE INDEX idx_git_history_rewrites_new_hash ON git_history_rewrites(project_id, new_hash)
  WHERE new_hash IS NOT NULL;

-- ----- code_decisions: the core. session_id NULLABLE (sessions arrive Plan 2). -----
CREATE TABLE code_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES code_sessions(id) ON DELETE SET NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision_type VARCHAR(64) NOT NULL,
  description TEXT NOT NULL,
  reasoning TEXT,
  alternatives_considered TEXT[],
  confidence FLOAT DEFAULT 0.8,
  still_valid BOOLEAN DEFAULT true,
  files_affected TEXT[],
  tags TEXT[] DEFAULT '{}',
  keywords TEXT[] DEFAULT '{}',
  source VARCHAR(32) DEFAULT 'agent-inferred',  -- user-approved | agent-inferred | session-extract | user-selected
  embedding DOUBLE PRECISION[],                 -- semantic search (cosine in Node when MAI_EMBEDDINGS=1)
  embedding_model TEXT,
  retracted_at TIMESTAMPTZ,
  retraction_reason TEXT,
  -- ----- Curation telemetry (plan 22, spec 2026-08-12). Counts, not scores:
  -- nothing selects on them and no path decrements them (the no-decay
  -- invariant). code_decisions.confidence is NEVER written by a citation path —
  -- it is a triage selector (reviewQueueRows selects confidence < 0.5), so a
  -- citation bump would silently drain the operator's review queue. -----
  surfaced_count INT NOT NULL DEFAULT 0,
  last_surfaced_at TIMESTAMPTZ,
  cited_count INT NOT NULL DEFAULT 0,
  last_cited_at TIMESTAMPTZ,
  reinforcement_count INT NOT NULL DEFAULT 0,
  -- Stamped ONCE by the migration on rows that predate curation, so the legacy
  -- corpus gets one fresh window before candidacy. NULL on every row created
  -- after, which is why the created-at floor is the permanent behaviour.
  curation_baseline_at TIMESTAMPTZ,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_code_decisions_project ON code_decisions(project_id);
CREATE INDEX idx_code_decisions_type ON code_decisions(decision_type);
CREATE INDEX idx_code_decisions_tags ON code_decisions USING gin(tags);
CREATE INDEX idx_code_decisions_keywords ON code_decisions USING gin(keywords);
CREATE INDEX idx_code_decisions_source ON code_decisions(source);
CREATE INDEX idx_code_decisions_trgm ON code_decisions USING gin (description gin_trgm_ops);

-- ----- lessons: project_id NULLABLE — NULL = global (readable by every project,
-- writable only via mai_globalize). -----
CREATE TABLE lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  context TEXT,
  why TEXT,
  how_to_apply TEXT,
  expected_outcome TEXT,
  actual_outcome TEXT,
  tags TEXT[] DEFAULT '{}',
  source_session_id UUID REFERENCES code_sessions(id) ON DELETE SET NULL,
  superseded_by UUID REFERENCES lessons(id) ON DELETE SET NULL,
  confidence_score DECIMAL(3,2) NOT NULL DEFAULT 0.50,
  confidence_label VARCHAR(16) GENERATED ALWAYS AS (
    CASE
      WHEN confidence_score < 0.35 THEN 'tentative'
      WHEN confidence_score < 0.75 THEN 'firm'
      ELSE 'proven'
    END
  ) STORED,
  reinforcement_count INT NOT NULL DEFAULT 0,
  -- The DEDICATED graduation signal (plan 27, decision 04c4848b): bumped ONLY
  -- by the dedup path, never by citation reinforcement. Merging the two is the
  -- reinforcement_count mistake this column exists to undo.
  relearned_count INT NOT NULL DEFAULT 0,
  -- ----- Curation telemetry + retirement (plan 22, spec 2026-08-12). Lessons
  -- had no retirement path (only superseded_by, which needs a replacement);
  -- §5.1's retire action and §10.3's every-project consequence require one.
  -- Operator-written only — no agent verb reaches retired_at. -----
  surfaced_count INT NOT NULL DEFAULT 0,
  last_surfaced_at TIMESTAMPTZ,
  cited_count INT NOT NULL DEFAULT 0,
  last_cited_at TIMESTAMPTZ,
  curation_baseline_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  retirement_reason TEXT,
  embedding DOUBLE PRECISION[],
  embedding_model TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_lessons_project ON lessons(project_id);
CREATE INDEX idx_lessons_trgm ON lessons USING gin (rule gin_trgm_ops);

-- ----- Plan findings tracker (plan 16, spec 2026-08-09 §5). Reviews and their
-- findings become first-class records: UUID-identified, status-carrying,
-- recurrence-linkable. The plan .md stays authoritative for CONTENT; `plans` is
-- identity + state. -----
CREATE TABLE plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug         text NOT NULL,
  path         text NOT NULL,
  title        text NOT NULL,
  current_sha  text,
  -- Root of this plan's derived board thread (plan 21 §6). Nullable; NO FK to
  -- agent_messages on purpose — board cleanup must never cascade into the
  -- tracker.
  board_thread_id uuid,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','reviewing','approved','executing','executed','abandoned')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_plans_project_path ON plans(project_id, path);

-- ----- Durable operator task inbox (Plan 43). Plan Markdown is authoritative
-- for plan-sourced content; these rows preserve assignment and operator state. -----
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
  source_plan_slug      text,
  removed_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_tasks_resolution_state CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolution_note IS NULL)
    OR (status = 'completed' AND resolved_at IS NOT NULL)
    OR (status = 'dismissed' AND resolved_at IS NOT NULL
        AND resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0)
  ),
  CONSTRAINT operator_tasks_source_identity CHECK (
    (source_kind = 'plan' AND source_plan_slug IS NOT NULL)
    OR (source_kind = 'ad_hoc' AND source_plan_slug IS NULL)
  ),
  CONSTRAINT operator_tasks_removed_terminal CHECK (
    removed_at IS NULL OR status IN ('completed','dismissed')
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
CREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_plan_source_key
  ON operator_tasks(project_id, source_plan_slug, task_key)
  WHERE source_kind = 'plan' AND source_plan_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS operator_tasks_visible
  ON operator_tasks(
    project_id, status, plan_id, resolved_at DESC NULLS LAST,
    kind, sort_order, created_at, id
  )
  WHERE removed_at IS NULL;

CREATE TABLE plan_reviews (
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

CREATE TABLE plan_findings (
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
CREATE INDEX idx_plan_findings_plan ON plan_findings(plan_id, status);
CREATE INDEX idx_plan_findings_project_sev ON plan_findings(project_id, severity);
CREATE INDEX idx_plan_findings_project_model ON plan_findings(project_id, embedding_model);
CREATE INDEX idx_plan_findings_trgm ON plan_findings USING gin (title gin_trgm_ops);

-- ----- code_findings: code-review findings (plan 24, spec 2026-08-13 §8).
-- NOT plan_findings: that table requires review_id -> plan_reviews, and a review
-- row requires a pass number and a verdict on the PLAN. A code review of one
-- task is neither. Here plan_id is OPTIONAL — set when the review ran during a
-- plan, NULL for an ad-hoc diff review — and SET NULL on plan delete, because
-- deleting a plan must not delete the record that a defect existed. -----
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

-- ----- doc_chunks: auto-ingested plan/spec chunks (plan 20, spec 2026-08-11).
-- Derived content — docs stay authoritative; recall serves path:line pointers.
-- doc_sha keys staleness; delete-and-rechunk per doc is atomic. repo_root =
-- the realpath'd registered root the path is relative to (the sweep covers
-- every registered repo — plan-20 finding 2481fa65). -----
CREATE TABLE IF NOT EXISTS doc_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id         uuid REFERENCES plans(id) ON DELETE CASCADE,  -- NULL = spec or unregistered plan file
  kind            text NOT NULL CHECK (kind IN ('plan','spec')),
  repo_root       text NOT NULL,
  path            text NOT NULL,   -- relative to repo_root; == plans.path under the project root
  doc_sha         text NOT NULL,
  chunk_index     int  NOT NULL,
  start_line      int  NOT NULL,
  end_line        int  NOT NULL,
  heading_trail   text NOT NULL,
  content         text NOT NULL,
  content_hash    text NOT NULL,
  embedding       double precision[],
  embedding_model text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, repo_root, path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_project_path ON doc_chunks(project_id, repo_root, path);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_project_model ON doc_chunks(project_id, embedding_model);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_plan ON doc_chunks(plan_id);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_trgm ON doc_chunks USING gin (content gin_trgm_ops);

-- ----- memory_edges: typed links between memories (spec §4). Open kind/relation
-- vocabularies since mai-graph 4a ('graph_node' is a kind; the agent-facing
-- mai_link tool still enums the asserted vocabulary in its schema). confidence:
-- 'asserted' (agent/user) | 'inferred' (machine-materialized, e.g. the
-- decisions→file linker). -----
CREATE TABLE memory_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  from_kind TEXT NOT NULL,
  from_id UUID NOT NULL,
  to_kind TEXT NOT NULL,
  to_id UUID NOT NULL,
  relation TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'asserted',
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_kind, from_id, to_kind, to_id, relation)
);
CREATE INDEX idx_memory_edges_project ON memory_edges(project_id);
CREATE INDEX idx_memory_edges_from ON memory_edges(from_kind, from_id);
CREATE INDEX idx_memory_edges_to ON memory_edges(to_kind, to_id);

-- ----- write_session_tokens: per-MCP-process gate state. (No per_component_reads
-- — Cat B was unreal-tooling-only and is dropped.) -----
CREATE TABLE write_session_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_pid INT NOT NULL,
  session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_set_ids JSONB NOT NULL DEFAULT '{}',   -- keys: 'lessons' | 'decisions'
  reads_count INT NOT NULL DEFAULT 0,
  writes_attempted INT NOT NULL DEFAULT 0,
  writes_succeeded INT NOT NULL DEFAULT 0,
  writes_rejected INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_write_session_tokens_project ON write_session_tokens(project_id);

-- ----- memory_citations: the citation the write-gate validates and used to
-- discard (plan 22, spec 2026-08-12 §2.2). The load-bearing half of the usage
-- model: counters for the cheap high-volume tier, ROWS for the rare expensive
-- one. Deliberately NOT memory_edges — that layer dedupes (erasing the count),
-- is agent-curated and operator-facing, and has no lifecycle state. -----
CREATE TABLE IF NOT EXISTS memory_citations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  citing_kind       text NOT NULL CHECK (citing_kind IN ('decision','lesson','finding')),
  citing_id         uuid,   -- set at INSERT time, inside the citing write's transaction
  cited_kind        text NOT NULL CHECK (cited_kind IN ('decision','lesson')),
  cited_id          uuid NOT NULL,
  relation          text NOT NULL CHECK (relation IN ('extends','supersedes','finding_ref')),
  reason            text NOT NULL,
  session_token_id  uuid REFERENCES write_session_tokens(id) ON DELETE SET NULL,
  agent             text,
  status            text NOT NULL DEFAULT 'recorded'
                    CHECK (status IN ('recorded','proposed','applied','dismissed')),
  resolved_at       timestamptz,
  resolved_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_citations_cited ON memory_citations(cited_kind, cited_id);
CREATE INDEX IF NOT EXISTS idx_memory_citations_open
  ON memory_citations(project_id, status) WHERE status = 'proposed';
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_citations_finding_ref
  ON memory_citations(project_id, citing_id, cited_kind, cited_id)
  WHERE citing_kind = 'finding' AND relation = 'finding_ref';

-- ----- curation_candidates: VERDICTS and agent proposals (plan 22 §4.2).
-- Telemetry candidates are a QUERY over the counters, never materialized here,
-- so this table only holds things a human or an agent explicitly said. -----
CREATE TABLE IF NOT EXISTS curation_candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind   text NOT NULL CHECK (target_kind IN ('decision','lesson')),
  target_id     uuid NOT NULL,
  basis         text NOT NULL CHECK (basis IN ('never-surfaced','never-cited','agent-evidence','graduate')),
  evidence      text,
  proposed_by   text,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','kept','applied','dismissed')),
  resolved_at   timestamptz,
  resolved_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_curation_candidates_open
  ON curation_candidates(project_id, target_kind, target_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_curation_candidates_target
  ON curation_candidates(project_id, target_kind, target_id, status);

-- ----- write_violations: audit log of rejected writes. -----
CREATE TABLE write_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_token_id UUID REFERENCES write_session_tokens(id) ON DELETE SET NULL,
  tool_name VARCHAR(64) NOT NULL,
  violation_kind VARCHAR(32) NOT NULL,
  attempted_payload TEXT NOT NULL,
  preview_results JSONB DEFAULT '[]',
  followup_succeeded BOOLEAN,
  followup_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_write_violations_project ON write_violations(project_id, rejected_at DESC);
CREATE INDEX idx_write_violations_kind ON write_violations(violation_kind);

-- ============================================================
-- mai-graph (Plan 4a — spec 2026-06-11-mai-graph-design.md §2)
-- ============================================================

CREATE TABLE IF NOT EXISTS graph_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- open vocabulary, per-extractor registry
  name TEXT NOT NULL,
  qualified_name TEXT,            -- e.g. app/src/lib/save.ts#saveWorkout
  file_path TEXT,
  line INT,
  lang VARCHAR(24),
  signature TEXT,
  content_hash VARCHAR(64),       -- staleness: sha256 of the defining file at extraction
  commit_sha VARCHAR(40),         -- staleness: repo HEAD at extraction
  extracted_by VARCHAR(32) NOT NULL,
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  UNIQUE(project_id, kind, qualified_name)
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_extractor ON graph_nodes(project_id, extracted_by);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_name_trgm ON graph_nodes USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_qname_trgm ON graph_nodes USING gin (qualified_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS graph_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_node UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  to_node UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,         -- open vocabulary, per-extractor registry
  confidence VARCHAR(16) NOT NULL DEFAULT 'extracted',  -- extracted | inferred | behavioral
  weight REAL DEFAULT 1.0,
  metadata JSONB DEFAULT '{}',
  UNIQUE(project_id, from_node, to_node, relation)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_graph_edges_relation ON graph_edges(project_id, relation);

CREATE TABLE IF NOT EXISTS ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global board
  title VARCHAR(200) NOT NULL,
  detail TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'idea',      -- idea | planned | building | shipped | dropped
  priority VARCHAR(16) NOT NULL DEFAULT 'someday', -- now | next | later | someday
  sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,  -- rank inside exact project/status/priority band; spaced and transactionally renumbered
  source VARCHAR(32) NOT NULL DEFAULT 'agent-inferred',  -- user | agent-inferred
  evidence TEXT,                                   -- required on agent moves; the plan/commit/decision cited
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ideas_board ON ideas (project_id, status, priority, sort_order);

-- Global by construction: facts describe the operator, not a project, so there
-- is deliberately no project_id column here.
CREATE TABLE IF NOT EXISTS user_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(16) NOT NULL,                   -- identity | preference | workflow | tooling
  fact VARCHAR(300) NOT NULL,                      -- one sentence
  detail TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'agent-inferred', -- agent-inferred | user-approved
  evidence TEXT NOT NULL,                          -- where the agent learned it
  retracted_at TIMESTAMPTZ,
  retraction_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operator display preferences (plan 30, spec 2026-08-18 §5). KV + jsonb:
-- string values today (roadmap.global_marker), structured values (plan 29's
-- themes) later with no schema change. Operator-level — deliberately no
-- project_id: display preferences belong to the operator, not to a board.
-- Keys are allowlisted in src/settings.ts; unknown keys are rejected there.
CREATE TABLE IF NOT EXISTS operator_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Incremental-ingest watermarks (plan 12, spec §3.4): one row per (project, transcript).
CREATE TABLE transcript_watermarks (
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transcript_path   text NOT NULL,
  harness           text NOT NULL,
  open_seq          integer NOT NULL,
  open_start_offset bigint  NOT NULL,
  ingested_mtime_ms bigint  NOT NULL,
  file_size_bytes   bigint  NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, transcript_path)
);

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

-- Semantic code search
CREATE TABLE graph_code_policy (
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
CREATE TABLE graph_code_embeddings (
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
CREATE TABLE graph_code_jobs (
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
CREATE UNIQUE INDEX graph_code_jobs_running
  ON graph_code_jobs(project_id) WHERE state = 'running';
CREATE INDEX graph_code_jobs_recent
  ON graph_code_jobs(project_id, created_at DESC, id);

-- Durable explicit lesson attachments; independent of derived semantic caches.
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
