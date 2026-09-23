// Client-side mirrors of the server JSON interfaces (src/graph/query.ts,
// src/graph/overview.ts, src/decisions.ts). Kept in sync by hand — a shared
// types package is out of scope (plan §, Task 4 note).

// --- graph/neighbors?format=json ---
export interface GraphJsonNode {
  id: string; kind: string; name: string;
  qualified_name: string | null; file_path: string | null; line: number | null;
  degree: number;
  lastTouched: string | null;
  confidence: number | null;
}
export interface GraphJsonEdge { source: string; target: string; relation: string; strength?: number }
export interface GraphNeighborsJson {
  center: string; capped: boolean;
  nodes: GraphJsonNode[]; edges: GraphJsonEdge[];
}

// --- graph/overview ---
export interface OverviewModule { label: string; nodeCount: number; kinds: Record<string, number> }
export interface OverviewLink { a: string; b: string; weight: number }
export interface OverviewTopNode {
  id: string; kind: string; name: string; module: string; degree: number;
  qualified_name: string | null; file_path: string | null; line: number | null;
  lastTouched: string | null;
  confidence: number | null;
}
export interface GraphOverview {
  modules: OverviewModule[]; links: OverviewLink[];
  topNodes: OverviewTopNode[];
  topEdges: { source: string; target: string; relation: string; strength?: number }[];
  freshness?: FreshnessBannerPayload;
}

// --- graph/full (plan 47 hero render) ---
// Field-for-field the server's FullNode. `module` is deliberately absent: it is
// a summary concept and the hero view has no modules.
export interface FullNode {
  id: string; kind: string; name: string; degree: number;
  qualified_name: string | null; file_path: string | null; line: number | null;
  lastTouched: string | null;
  confidence: number | null;
  isLanding: 0 | 1;
}
export interface GraphFull {
  nodes: FullNode[];
  edges: { source: string; target: string; relation: string; strength?: number }[];
  truncated: { nodes: boolean; edges: boolean; nodeTotal: number; edgeTotal: number };
}

// --- graph/freshness (plan 28 GraphFreshness, rendered server-side) ---
// The server sends already-rendered sentences (plan 29 R10/D10): the frontend
// composes no freshness wording, so prime and the banner cannot drift. This is
// deliberately NOT a mirror of DbSchemaState — that type carries a `Date`, which
// does not survive JSON.
export interface FreshnessLine { tone: 'ok' | 'warn' | 'info'; text: string }
export interface FreshnessBannerPayload { code: FreshnessLine; db: FreshnessLine }

// --- graph/find (nodes) ---
export interface GraphFoundNode {
  id: string; kind: string; name: string;
  qualified_name: string | null; file_path: string | null; line: number | null;
  score: number;
}

// --- review?format=json ---
export type CurationAction = 'keep' | 'retire' | 'apply' | 'dismiss' | 'promote' | 'reject';

/** Mirror of src/curation.ts#CurationCard. approveLabel/denyLabel and the two
 * action enums are SERVER-AUTHORITATIVE: approve/deny invert between queue
 * kinds (plan 22 §5.1), so the view renders and dispatches, never derives. */
export interface CurationCard {
  basis: 'never-surfaced' | 'never-cited' | 'agent-evidence' | 'graduate';
  targetKind: 'decision' | 'lesson';
  targetId: string;
  targetSummary: string;
  isGlobal: boolean;
  globalNote: string | null;
  surfacedCount: number;
  citedCount: number;
  lastSurfacedAt: string | null;
  relearnedCount: number | null;
  proposedBy: string | null;
  evidence: string | null;
  replacementId: string | null;
  replacementSummary: string | null;
  candidateId: string | null;
  citationId: string | null;
  approveLabel: string;
  approveAction: CurationAction;
  denyLabel: string;
  denyAction: CurationAction;
}

export interface ReviewRowBase {
  id: string; decision_type: string; description: string; reasoning: string | null;
  confidence: number; source: string; keywords: string[]; timestamp: string;
}
export interface DecisionReviewRow extends ReviewRowBase { kind: 'decision' }
export interface FactReviewRow extends ReviewRowBase { kind: 'fact' }
export interface CurationReviewRow extends ReviewRowBase {
  kind: 'curation';
  curation: CurationCard;
}
export type ReviewRow = DecisionReviewRow | FactReviewRow | CurationReviewRow;

// --- ideas ---
export type IdeaStatus = 'idea' | 'planned' | 'building' | 'shipped' | 'dropped';
export type IdeaPriority = 'now' | 'next' | 'later' | 'someday';
export interface IdeaRow {
  id: string; project_id: string | null; title: string; detail: string | null;
  status: IdeaStatus; priority: IdeaPriority; sort_order: number;
  source: string; evidence: string | null; created_at: string; updated_at: string;
}

// --- facts ---
export type FactCategory = 'identity' | 'preference' | 'workflow' | 'tooling';
export interface FactRow {
  id: string; category: FactCategory; fact: string; detail: string | null;
  source: string; evidence: string; retracted_at: string | null;
  retraction_reason: string | null; created_at: string;
}

// --- activity ---
export interface ActivityRow {
  kind: 'session' | 'decision' | 'commit'; ts: string; id: string; detail: string | null;
}

// --- projects ---
export interface ProjectRow {
  id: string; slug: string; name: string | null; last_active_at: string;
}

// --- operator tasks ---
export type UserTaskKind = 'blocking' | 'follow_up';
export type UserTaskStatus = 'pending' | 'completed' | 'dismissed';
export type UserTaskSource = 'plan' | 'ad_hoc';

export interface UserTaskRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  task_key: string;
  source_kind: UserTaskSource;
  kind: UserTaskKind;
  title: string;
  instructions: string;
  assigned_by_agent: string;
  assigned_by_session: string;
  sort_order: number;
  status: UserTaskStatus;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  plan_title: string | null;
  plan_path: string | null;
  plan_status: string | null;
  plan_sha: string | null;
  plan_updated_at: string | null;
}

export interface UserTaskGroup {
  group_key: string;
  group_kind: 'plan' | 'unlinked';
  plan_id: string | null;
  plan_title: string | null;
  plan_path: string | null;
  plan_status: string | null;
  plan_sha: string | null;
  pending_count: number;
  blocking_count: number;
  follow_up_count: number;
  removal_snapshot: string | null;
  tasks: UserTaskRow[];
}

export interface UserTaskListResponse {
  pending_count: number;
  blocking_count: number;
  follow_up_count: number;
  rows: UserTaskRow[];
  groups: UserTaskGroup[];
}

export interface UserTaskMutationResponse {
  task: UserTaskRow;
  pending_count: number;
  blocking_count: number;
  follow_up_count: number;
}

export interface UserTaskRemoveResponse {
  removed_count: number;
}
