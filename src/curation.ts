// Curation loops (plan 22, spec docs/superpowers/specs/2026-08-12-curation-loops-design.md).
// Two-tier usage telemetry (§2) + the operator-gated supersede/prune pass (§4).
//
// THE INVARIANT THIS MODULE EXISTS TO KEEP: nothing here mutates or retires a
// curated memory except `curationRetire` / `curationApply` / `curationUnretire`,
// whose only callers are the operator POST routes. Everything an agent can
// reach writes counters or files a PROPOSAL. "Your brain never rewrites itself
// behind your back" is the product claim, and it is ENFORCED here, not
// documented here.
//
// IMPORT DISCIPLINE — the rule that keeps this module acyclic, stated as what
// actually holds it. This module statically imports ONLY db.js and
// session-identity.js, and every edge OUT of here into decisions.ts /
// lessons.ts is a DYNAMIC import.
//
// The edges INTO this module are ordinary static imports: write-gate.ts,
// decisions.ts, plans.ts, prime.ts and web-review-handlers.ts all import from
// './curation.js' at module level (lessons.ts's is type-only and erased at emit). They are safe
// precisely BECAUSE this module imports none of them back — not because they
// are deferred, which they are not.
//
// So the rule to preserve when editing this file is: DO NOT ADD to the static
// import list above. Reading it the other way round — "inbound edges are
// dynamic, so a static import from here is fine" — is how the cycle gets
// created later.
import type { QueryResult, QueryResultRow } from 'pg';
import { getPool, getProjectId } from './db.js';
import { agentIdentity } from './session-identity.js';

/**
 * Anything that can run a parameterized statement: `getPool()` OR a checked-out
 * transaction client. The citation write MUST run on the citing INSERT's client
 * (spec §2.3), while the lesson-reinforcement helper is shared with
 * `lessonAdd`'s transaction-backed dedup path — one structural type serves both, so
 * there is ONE reinforcement implementation rather than two.
 */
export interface SqlRunner {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * THE curation window. A constant, deliberately NOT configurable (spec §3.2):
 * a tunable threshold is a mute button that looks like a preference — widen it
 * twice and the loop is off with no signal that it was turned off. Tests import
 * this; no assertion anywhere hardcodes 90.
 */
export const CURATION_WINDOW_DAYS = 90;

/**
 * Graduation threshold (plan 27 §3.1): a lesson independently relearned this
 * many times is proposed as an enforced project rule. A CONSTANT for the same
 * reason as CURATION_WINDOW_DAYS — a tunable threshold is a mute button that
 * looks like a preference. Imported by the query, the card, the prime line and
 * the tests; no assertion hardcodes 5.
 */
export const GRADUATION_REINFORCEMENTS = 5;

/** Rendered verbatim on every global-lesson card, in markdown AND JSON — per
 * spec §10.3 this disclosure is the whole mitigation for including globals in
 * candidacy, so it is a required element, not decoration. */
export const GLOBAL_CONSEQUENCE =
  'GLOBAL lesson — retiring it removes this rule from EVERY project, not just this one.';

export type CuratedKind = 'decision' | 'lesson';
export type CitingKind = 'decision' | 'lesson' | 'finding';
export type CitationRelation = 'extends' | 'supersedes' | 'finding_ref';
export type CandidateBasis = 'never-surfaced' | 'never-cited' | 'agent-evidence' | 'graduate';
export type CurationAction = 'keep' | 'retire' | 'apply' | 'dismiss' | 'promote' | 'reject';

/** Sources that mean an operator was already in the loop for the citing write
 * (spec §4.1) — their supersessions file as `recorded`, not `proposed`. */
const OPERATOR_SOURCES = ['user-approved', 'user-selected'];

// ---------- §2.1 surfaced tier ----------

/**
 * Bump the surfaced counters for one read's result set. Called from exactly one
 * place — `recordReadResults` in write-gate.ts — which every present and future
 * read verb already funnels through (spec §2.1). `id = ANY($1)` increments each
 * row ONCE regardless of duplicates in the array, so one search can never
 * double-count an entry. No project filter: the ids came from a project-scoped
 * read, and a global lesson's counters are cross-project sums by construction
 * (spec §3.1) — which is exactly the number candidacy asks for.
 */
export async function bumpSurfaced(bucket: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getPool();
  if (bucket === 'decisions') {
    await pool.query(
      `UPDATE code_decisions
          SET surfaced_count = surfaced_count + 1, last_surfaced_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    return;
  }
  if (bucket === 'lessons') {
    await pool.query(
      `UPDATE lessons
          SET surfaced_count = surfaced_count + 1, last_surfaced_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );
  }
  // 'notes' mints no counter (spec §2.1).
}

// ---------- §2.2 load-bearing tier ----------

export interface CitationToRecord {
  citingKind: CitingKind;
  citingId: string;
  citedKind: CuratedKind;
  citedId: string;
  relation: CitationRelation;
  reason: string;
  sessionTokenId: string | null;
  /** The citing write's `source`. Decides recorded-vs-proposed (spec §4.1). */
  source: string;
}

/**
 * Persist the citation the write-gate validated and used to throw away (spec
 * §2.2), and move the cited entry's load-bearing counters.
 *
 * MUST be called with the SAME client/transaction as the citing INSERT: a write
 * that fails after gate approval must not manufacture a load-bearing signal
 * (spec §2.3). Callers pass the transaction's client; there is deliberately no
 * pool default.
 */
export async function recordCitation(
  client: SqlRunner,
  projectId: string,
  c: CitationToRecord
): Promise<string> {
  const status =
    c.relation === 'supersedes' && !OPERATOR_SOURCES.includes(c.source) ? 'proposed' : 'recorded';
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO memory_citations
       (project_id, citing_kind, citing_id, cited_kind, cited_id, relation,
        reason, session_token_id, agent, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      projectId, c.citingKind, c.citingId, c.citedKind, c.citedId, c.relation,
      c.reason, c.sessionTokenId, agentIdentity(), status,
    ]
  );
  await bumpCited(client, c.citedKind, c.citedId);
  return inserted.rows[0].id;
}

/** Full UUIDs only — never pass-local `B1` labels or 8-hex display prefixes.
 * The regex finds candidates; the project-scoped live-row queries below are
 * the authority. Repeats across issue/evidence collapse before SQL. */
const FULL_UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Persist the spec §2.3 finding_ref lane. Called on the SAME transaction
 * client as the finding INSERT/UPDATE. Unknown, foreign and non-live ids are
 * ignored: a regex candidate is not a citation until it resolves under the
 * pinned project. Global lessons are visible to every project and therefore
 * resolve here under the same `(project_id = $1 OR project_id IS NULL)` wall
 * used by lesson reads.
 *
 * Idempotency is semantic, not best-effort: the partial unique index allows
 * one row per finding/target and this function bumps counters ONLY when the
 * INSERT returns a row. Re-scanning from mai_finding_update backfills old
 * findings and never double-counts an already-recorded reference.
 */
export async function recordFindingReferences(
  client: SqlRunner,
  projectId: string,
  findingId: string,
  issue: string,
  evidence: string
): Promise<number> {
  const ids = [...new Set(
    [...`${issue}\n${evidence}`.matchAll(FULL_UUID_IN_TEXT)].map((m) => m[0].toLowerCase())
  )].sort();
  if (ids.length === 0) return 0;

  // Lock in stable order so liveness stays true through the counter bump and
  // concurrent findings that cite the same set cannot deadlock by input order.
  const decisions = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM code_decisions
      WHERE project_id = $1 AND id = ANY($2::uuid[])
        AND still_valid = true AND retracted_at IS NULL
      ORDER BY id FOR UPDATE`,
    [projectId, ids]
  );
  const lessons = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM lessons
      WHERE (project_id = $1 OR project_id IS NULL) AND id = ANY($2::uuid[])
        AND superseded_by IS NULL AND retired_at IS NULL
      ORDER BY id FOR UPDATE`,
    [projectId, ids]
  );

  const targets: Array<{ kind: CuratedKind; id: string }> = [
    ...decisions.rows.map((r): { kind: CuratedKind; id: string } => ({ kind: 'decision', id: r.id })),
    ...lessons.rows.map((r): { kind: CuratedKind; id: string } => ({ kind: 'lesson', id: r.id })),
  ];
  let insertedCount = 0;
  for (const target of targets) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO memory_citations
         (project_id, citing_kind, citing_id, cited_kind, cited_id, relation,
          reason, session_token_id, agent, status)
       VALUES ($1,'finding',$2,$3,$4,'finding_ref',$5,NULL,$6,'recorded')
       ON CONFLICT (project_id, citing_id, cited_kind, cited_id)
         WHERE citing_kind = 'finding' AND relation = 'finding_ref'
       DO NOTHING
       RETURNING id`,
      // Source-NEUTRAL on purpose (plan 24 finding a9e34a1f). Plan 24 calls this
      // same helper from codeFindingAdd, so a hardcoded "plan finding" would
      // label every code-finding citation with false provenance in durable
      // memory_citations data — and it is surfaced as `evidence` at :471, where
      // nobody could tell it was wrong. `citing_id` already identifies which
      // finding; the reason should not contradict it.
      [projectId, findingId, target.kind, target.id,
       'Referenced by finding issue/evidence.', agentIdentity()]
    );
    if (inserted.rows.length === 0) continue;
    await bumpCited(client, target.kind, target.id);
    insertedCount += 1;
  }
  return insertedCount;
}

/**
 * Move the cited entry's counters. LESSONS-ONLY reinforcement of the score
 * (spec §6, decision aebc6583): both kinds get `cited_count` / `last_cited_at`
 * / `reinforcement_count` — those are COUNTS and nothing selects on them — but
 * only lessons get `confidence_score` moved. `code_decisions.confidence` is a
 * TRIAGE SELECTOR (`reviewQueueRows` selects `confidence < 0.5`), so bumping it
 * on citation would let telemetry silently drain the operator's review queue —
 * the exact never-behind-your-back failure this build exists to prevent. The
 * asymmetry is deliberate; a later refactor "tidying it up" into symmetry is a
 * regression, which is why it has its own named test AND a repo-wide gate.
 */
async function bumpCited(client: SqlRunner, kind: CuratedKind, id: string): Promise<void> {
  if (kind === 'decision') {
    await client.query(
      `UPDATE code_decisions
          SET cited_count = cited_count + 1,
              last_cited_at = NOW(),
              reinforcement_count = reinforcement_count + 1
        WHERE id = $1`,
      [id]
    );
    return;
  }
  await client.query(
    `UPDATE lessons
        SET cited_count = cited_count + 1, last_cited_at = NOW()
      WHERE id = $1`,
    [id]
  );
  const { reinforceLesson } = await import('./lessons.js');
  await reinforceLesson(client, id);
}

// ---------- §3 prune candidates (computed, never materialized) ----------

export interface CurationCandidate {
  targetKind: CuratedKind;
  targetId: string;
  targetSummary: string;
  basis: 'never-surfaced' | 'never-cited';
  surfacedCount: number;
  citedCount: number;
  lastSurfacedAt: string | null;
  isGlobal: boolean;
}

interface CandidateQueryRow {
  target_kind: string;
  target_id: string;
  summary: string;
  surfaced_count: number;
  cited_count: number;
  last_surfaced_at: Date | null;
  created_at: Date;
  is_global: boolean;
  operator_approved: boolean;
}

function toCuratedKind(raw: string): CuratedKind {
  return raw === 'lesson' ? 'lesson' : 'decision';
}

/**
 * The candidacy predicate (spec §3.1), as ONE SQL constant shared by the row
 * query and the count query — build-once, so the prime line can never advertise
 * a queue that isn't there. Params: $1 project, $2 window days, $3 operator
 * sources. The row query appends ORDER BY + LIMIT $4.
 *
 * It is a QUERY over the counters, never a materialized sweep (spec §4.3), so
 * the set is always current by construction.
 *
 * The two disjuncts "never surfaced" and "surfaced but never load-bearing"
 * collapse to exactly `cited_count = 0`; `basis` then distinguishes them by
 * `surfaced_count`. (Stated explicitly so a reviewer does not read the single
 * predicate as a dropped branch.)
 *
 * Age floor: `GREATEST(<created>, COALESCE(curation_baseline_at, <created>))`.
 * `curation_baseline_at` is NULL on every row created after the migration, so
 * the permanent behaviour is spec §3.1's created-at floor; the migration stamps
 * it ONCE on pre-existing rows so the legacy corpus gets one fresh window to
 * earn its keep (spec §7, plan 22 ambiguity 2).
 */
const CANDIDATE_SQL = `
  SELECT 'decision'::text AS target_kind,
         d.id::text       AS target_id,
         d.description    AS summary,
         d.surfaced_count, d.cited_count, d.last_surfaced_at,
         d.timestamp      AS created_at,
         false            AS is_global,
         (d.source = ANY($3::text[])) AS operator_approved
    FROM code_decisions d
   WHERE d.project_id = $1
     AND d.still_valid = true
     AND d.retracted_at IS NULL
     AND d.cited_count = 0
     AND GREATEST(d.timestamp, COALESCE(d.curation_baseline_at, d.timestamp))
         < NOW() - make_interval(days => $2::int)
     AND NOT EXISTS (
           SELECT 1 FROM curation_candidates c
            WHERE c.project_id = $1 AND c.target_kind = 'decision' AND c.target_id = d.id
              AND (c.status = 'open'
                   OR (c.status = 'kept'
                       AND c.resolved_at > NOW() - make_interval(days => $2::int))))
  UNION ALL
  SELECT 'lesson', l.id::text, l.rule,
         l.surfaced_count, l.cited_count, l.last_surfaced_at,
         l.created_at,
         (l.project_id IS NULL),
         false
    FROM lessons l
   WHERE (l.project_id = $1 OR l.project_id IS NULL)
     AND l.superseded_by IS NULL
     AND l.retired_at IS NULL
     AND l.cited_count = 0
     AND GREATEST(l.created_at, COALESCE(l.curation_baseline_at, l.created_at))
         < NOW() - make_interval(days => $2::int)
     AND NOT EXISTS (
           SELECT 1 FROM curation_candidates c
            WHERE c.project_id = $1 AND c.target_kind = 'lesson' AND c.target_id = l.id
              AND (c.status = 'open'
                   OR (c.status = 'kept'
                       AND c.resolved_at > NOW() - make_interval(days => $2::int))))
     -- Proposal/graduation precedence (Plan 22 duplicate-card recurrence): a
     -- project-local lesson eligible for graduation must not also surface as
     -- a telemetry prune card with the opposite approve/deny semantics.
     AND NOT (
       l.project_id = $1
       AND l.relearned_count >= $4::int
     )`;

export async function curationCandidates(
  projectId: string,
  limit = 30
): Promise<CurationCandidate[]> {
  if (limit <= 0) return [];
  const r = await getPool().query<CandidateQueryRow>(
    `SELECT * FROM (${CANDIDATE_SQL}) q
      ORDER BY q.operator_approved ASC, q.surfaced_count DESC, q.created_at ASC
      LIMIT $5`,
    [projectId, CURATION_WINDOW_DAYS, OPERATOR_SOURCES,
     GRADUATION_REINFORCEMENTS, limit]
  );
  return r.rows.map((row) => ({
    targetKind: toCuratedKind(row.target_kind),
    targetId: row.target_id,
    targetSummary: row.summary,
    basis: Number(row.surfaced_count) === 0 ? 'never-surfaced' : 'never-cited',
    surfacedCount: Number(row.surfaced_count),
    citedCount: Number(row.cited_count),
    lastSurfacedAt: row.last_surfaced_at ? new Date(row.last_surfaced_at).toISOString() : null,
    isGlobal: row.is_global === true,
  }));
}

// ---------- plan 27 §3: graduation candidates (computed, never materialized) ----------

export interface GraduationCandidate {
  targetId: string;
  rule: string;
  relearnedCount: number;
}

/**
 * The graduation predicate as ONE SQL constant shared by rows and count (the
 * CANDIDATE_SQL discipline). Project-LOCAL only — `l.project_id = $1`, never
 * the `OR IS NULL` global wall: globals are excluded from graduation end to
 * end (spec §4). Suppression: an `applied` graduate verdict suppresses forever,
 * a `dismissed` one for one window; `open` is included defensively although no
 * code path creates open graduate rows. Params: $1 project, $2 threshold,
 * $3 window days. The row query appends ORDER BY + LIMIT $4.
 */
const GRADUATION_SQL = `
  SELECT l.id::text        AS target_id,
         l.rule            AS rule,
         l.relearned_count AS relearned_count,
         l.created_at      AS created_at
    FROM lessons l
   WHERE l.project_id = $1
     AND l.superseded_by IS NULL
     AND l.retired_at IS NULL
     AND l.relearned_count >= $2::int
     -- Stored correction proposals outrank graduation: never show PROMOTE
     -- beside RETIRE/APPLY for the same target.
     AND NOT EXISTS (
           SELECT 1 FROM curation_candidates c
            WHERE c.project_id = $1 AND c.target_kind = 'lesson' AND c.target_id = l.id
              AND c.status = 'open')
     AND NOT EXISTS (
           SELECT 1 FROM memory_citations mc
            WHERE mc.project_id = $1 AND mc.cited_kind = 'lesson' AND mc.cited_id = l.id
              AND mc.status = 'proposed')
     AND NOT EXISTS (
           SELECT 1 FROM curation_candidates c
            WHERE c.project_id = $1 AND c.target_kind = 'lesson' AND c.target_id = l.id
              AND c.basis = 'graduate'
              AND (c.status IN ('applied','open')
                   OR (c.status = 'dismissed'
                       AND c.resolved_at > NOW() - make_interval(days => $3::int))))`;

export async function graduationCandidates(
  projectId: string,
  limit = 30
): Promise<GraduationCandidate[]> {
  if (limit <= 0) return [];
  const r = await getPool().query<{ target_id: string; rule: string; relearned_count: number }>(
    `SELECT * FROM (${GRADUATION_SQL}) g
      ORDER BY g.relearned_count DESC, g.created_at ASC
      LIMIT $4`,
    [projectId, GRADUATION_REINFORCEMENTS, CURATION_WINDOW_DAYS, limit]
  );
  return r.rows.map((row) => ({
    targetId: row.target_id,
    rule: row.rule,
    relearnedCount: Number(row.relearned_count),
  }));
}

/** Counts for the prime line — the SAME predicates, never second ones. */
export async function curationCounts(
  projectId: string
): Promise<{ candidates: number; proposals: number; graduations: number }> {
  const pool = getPool();
  const [cand, prop, grad] = await Promise.all([
    pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${CANDIDATE_SQL}) q`, [
      projectId, CURATION_WINDOW_DAYS, OPERATOR_SOURCES, GRADUATION_REINFORCEMENTS,
    ]),
    pool.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM memory_citations
                WHERE project_id = $1 AND status = 'proposed')
            + (SELECT count(*) FROM curation_candidates
                WHERE project_id = $1 AND status = 'open') AS n`,
      [projectId]
    ),
    pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${GRADUATION_SQL}) g`, [
      projectId, GRADUATION_REINFORCEMENTS, CURATION_WINDOW_DAYS,
    ]),
  ]);
  return {
    candidates: Number(cand.rows[0]?.n ?? 0),
    proposals: Number(prop.rows[0]?.n ?? 0),
    graduations: Number(grad.rows[0]?.n ?? 0),
  };
}

// ---------- §4 proposals (stored) ----------

export interface CurationProposal {
  proposalKind: 'supersede' | 'retract';
  /** memory_citations.id for a supersession, curation_candidates.id otherwise. */
  id: string;
  targetKind: CuratedKind;
  targetId: string;
  targetSummary: string;
  isGlobal: boolean;
  proposedBy: string | null;
  evidence: string;
  replacementId: string | null;
  replacementSummary: string | null;
}

interface SupersedeRow {
  id: string;
  cited_kind: string;
  cited_id: string;
  citing_id: string | null;
  reason: string;
  agent: string | null;
  target_summary: string | null;
  is_global: boolean;
  replacement_summary: string | null;
}

interface RetractRow {
  id: string;
  target_kind: string;
  target_id: string;
  evidence: string | null;
  proposed_by: string | null;
  target_summary: string | null;
  is_global: boolean;
}

export async function curationProposals(
  projectId: string,
  limit = 30
): Promise<CurationProposal[]> {
  const pool = getPool();
  const [sup, ret] = await Promise.all([
    pool.query<SupersedeRow>(
      // The two LEFT JOIN pairs resolve BOTH ends against both tables: the
      // `cited_kind = '<k>' AND` guard is load-bearing — without it a decision
      // row would match `lc.project_id IS NULL` and be labelled GLOBAL.
      `SELECT mc.id::text AS id, mc.cited_kind, mc.cited_id::text AS cited_id,
              mc.citing_id::text AS citing_id, mc.reason, mc.agent,
              COALESCE(dc.description, lc.rule) AS target_summary,
              (mc.cited_kind = 'lesson' AND lc.project_id IS NULL) AS is_global,
              COALESCE(dn.description, ln.rule) AS replacement_summary
         FROM memory_citations mc
         LEFT JOIN code_decisions dc ON mc.cited_kind  = 'decision' AND dc.id = mc.cited_id
         LEFT JOIN lessons       lc ON mc.cited_kind  = 'lesson'   AND lc.id = mc.cited_id
         LEFT JOIN code_decisions dn ON mc.citing_kind = 'decision' AND dn.id = mc.citing_id
         LEFT JOIN lessons       ln ON mc.citing_kind = 'lesson'   AND ln.id = mc.citing_id
        WHERE mc.project_id = $1 AND mc.status = 'proposed'
        ORDER BY mc.created_at ASC
        LIMIT $2`,
      [projectId, limit]
    ),
    pool.query<RetractRow>(
      `SELECT cc.id::text AS id, cc.target_kind, cc.target_id::text AS target_id,
              cc.evidence, cc.proposed_by,
              COALESCE(d.description, l.rule) AS target_summary,
              (cc.target_kind = 'lesson' AND l.project_id IS NULL) AS is_global
         FROM curation_candidates cc
         LEFT JOIN code_decisions d ON cc.target_kind = 'decision' AND d.id = cc.target_id
         LEFT JOIN lessons       l ON cc.target_kind = 'lesson'   AND l.id = cc.target_id
        WHERE cc.project_id = $1 AND cc.status = 'open'
        ORDER BY cc.created_at ASC
        LIMIT $2`,
      [projectId, limit]
    ),
  ]);

  const supersedes: CurationProposal[] = sup.rows.map((row) => ({
    proposalKind: 'supersede',
    id: row.id,
    targetKind: toCuratedKind(row.cited_kind),
    targetId: row.cited_id,
    targetSummary: row.target_summary ?? '(entry no longer present)',
    isGlobal: row.is_global === true,
    proposedBy: row.agent,
    evidence: row.reason,
    replacementId: row.citing_id,
    replacementSummary: row.replacement_summary,
  }));
  const retracts: CurationProposal[] = ret.rows.map((row) => ({
    proposalKind: 'retract',
    id: row.id,
    targetKind: toCuratedKind(row.target_kind),
    targetId: row.target_id,
    targetSummary: row.target_summary ?? '(entry no longer present)',
    isGlobal: row.is_global === true,
    proposedBy: row.proposed_by,
    evidence: row.evidence ?? '',
    replacementId: null,
    replacementSummary: null,
  }));
  return [...supersedes, ...retracts].slice(0, limit);
}

// ---------- §5.1 queue cards ----------

export interface CurationCard {
  basis: CandidateBasis;
  targetKind: CuratedKind;
  targetId: string;
  targetSummary: string;
  isGlobal: boolean;
  /** The every-project consequence, VERBATIM, when isGlobal — else null. */
  globalNote: string | null;
  surfacedCount: number;
  citedCount: number;
  lastSurfacedAt: string | null;
  proposedBy: string | null;
  evidence: string | null;
  replacementId: string | null;
  replacementSummary: string | null;
  candidateId: string | null;
  citationId: string | null;
  /** Graduate cards only (plan 27); null on every other basis. */
  relearnedCount: number | null;
  /** SERVER-AUTHORITATIVE, because approve/deny INVERT between queue kinds
   * (spec §5.1) and even between curation sub-kinds: `a` on a decision means
   * "this is good", `a` on a prune candidate means "keep it", `a` on a
   * supersede proposal means "apply it" (destructive). The view renders these
   * words and dispatches on the action enum; it never derives either. */
  approveLabel: string;
  approveAction: CurationAction;
  denyLabel: string;
  denyAction: CurationAction;
}

/** Proposals first (an agent brought evidence and a human is waiting on it),
 * telemetry candidates after. */
export async function curationCards(projectId: string, limit = 30): Promise<CurationCard[]> {
  if (limit <= 0) return [];
  const proposals = await curationProposals(projectId, limit);
  // Graduations rank between agent proposals and telemetry candidates: a
  // 5×-relearned lesson is evidence-driven, a never-cited entry is only silence.
  const gradBudget = limit - proposals.length;
  const graduations = gradBudget > 0 ? await graduationCandidates(projectId, gradBudget) : [];
  const remaining = limit - proposals.length - graduations.length;
  const candidates = remaining > 0 ? await curationCandidates(projectId, remaining) : [];

  const proposalCards: CurationCard[] = proposals.map((p) => ({
    basis: 'agent-evidence',
    targetKind: p.targetKind,
    targetId: p.targetId,
    targetSummary: p.targetSummary,
    isGlobal: p.isGlobal,
    globalNote: p.isGlobal ? GLOBAL_CONSEQUENCE : null,
    surfacedCount: 0,
    citedCount: 0,
    lastSurfacedAt: null,
    relearnedCount: null,
    proposedBy: p.proposedBy,
    evidence: p.evidence,
    replacementId: p.replacementId,
    replacementSummary: p.replacementSummary,
    candidateId: p.proposalKind === 'retract' ? p.id : null,
    citationId: p.proposalKind === 'supersede' ? p.id : null,
    approveLabel: p.proposalKind === 'supersede' ? 'Apply supersession' : 'Retire (apply proposal)',
    approveAction: p.proposalKind === 'supersede' ? 'apply' : 'retire',
    denyLabel: p.proposalKind === 'supersede' ? 'Dismiss proposal' : 'Keep entry',
    denyAction: p.proposalKind === 'supersede' ? 'dismiss' : 'keep',
  }));

  const candidateCards: CurationCard[] = candidates.map((c) => ({
    basis: c.basis,
    targetKind: c.targetKind,
    targetId: c.targetId,
    targetSummary: c.targetSummary,
    isGlobal: c.isGlobal,
    globalNote: c.isGlobal ? GLOBAL_CONSEQUENCE : null,
    surfacedCount: c.surfacedCount,
    citedCount: c.citedCount,
    lastSurfacedAt: c.lastSurfacedAt,
    relearnedCount: null,
    proposedBy: null,
    evidence: null,
    replacementId: null,
    replacementSummary: null,
    candidateId: null,
    citationId: null,
    approveLabel: 'Keep entry',
    approveAction: 'keep',
    denyLabel: 'Retire entry',
    denyAction: 'retire',
  }));

  const graduationCards: CurationCard[] = graduations.map((g) => ({
    basis: 'graduate',
    targetKind: 'lesson',
    targetId: g.targetId,
    targetSummary: g.rule,
    isGlobal: false, // candidacy is project-local by query (spec §4)
    globalNote: null,
    surfacedCount: 0,
    citedCount: 0,
    lastSurfacedAt: null,
    relearnedCount: g.relearnedCount,
    proposedBy: null,
    evidence: null,
    replacementId: null,
    replacementSummary: null,
    candidateId: null,
    citationId: null,
    approveLabel: 'Promote to project rule',
    approveAction: 'promote',
    denyLabel: 'Not a rule',
    denyAction: 'reject',
  }));

  return [...proposalCards, ...graduationCards, ...candidateCards];
}

// ---------- §5.2 prime line ----------

/** One line, null when the queue is clean — the `primeFactsSection` /
 * `primeIdeasSection` contract (a clean brain adds zero bytes). Deliberately
 * NOT in `primeStartup()`: that briefing is pinned under 1,500 chars by
 * context-budget.test.ts, and the curation line is an OPERATOR signal that
 * belongs where the agent has a task and read tokens (spec §5.2). */
/** The exact maximum of the BUDGETED curation line: three six-digit counts. */
export const CURATION_LINE_MAX = 73;

/**
 * Bounded count display (plan 38). Exact through 999,999; `≥1M` above that;
 * `?` for anything that is not a non-negative safe integer — a fabricated exact
 * count is worse than an honest unknown. Plural/state decisions still use the
 * RAW validated count, never this token.
 */
function boundedCount(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) return '?';
  return n >= 1_000_000 ? '≥1M' : String(n);
}

/** The budgeted envelope form: all three queue categories survive even at zero,
 * because the operator signal is the queue's shape, not its size. */
export function renderCurationPrimeEnvelopeLine(counts: {
  candidates: number; proposals: number; graduations: number;
}): string {
  return `_Curation: prune ${boundedCount(counts.candidates)}; ` +
    `graduate ${boundedCount(counts.graduations)}; ` +
    `proposals ${boundedCount(counts.proposals)} — mai_review._`;
}

export async function primeCurationSection(
  projectId: string, budgeted = false,
): Promise<string | null> {
  const { candidates, proposals, graduations } = await curationCounts(projectId);
  if (candidates === 0 && proposals === 0 && graduations === 0) return null;
  if (budgeted) return renderCurationPrimeEnvelopeLine({ candidates, proposals, graduations });
  const parts: string[] = [];
  if (candidates > 0) parts.push(`${candidates} prune candidate${candidates === 1 ? '' : 's'}`);
  if (graduations > 0) parts.push(`${graduations} graduation candidate${graduations === 1 ? '' : 's'}`);
  if (proposals > 0) parts.push(`${proposals} proposal${proposals === 1 ? '' : 's'}`);
  return `_Curation: ${parts.join(', ')} awaiting your review — mai_review._`;
}

// ---------- §4.2 agent-facing retraction: PROPOSE ONLY ----------

/**
 * The agent-facing arm of `mai_retract` (spec §4.2, decision aebc6583). The
 * tool's approval gate used to be prose in its own description, and prose is a
 * request, not a guarantee. This arm accepts proposals and NOTHING else: a call
 * without `propose: true` is rejected and names the propose form. Direct
 * retraction keeps working on the surfaces that already belong to the operator
 * (the dashboard triage, /api/curation/retire, `mai retract` in the CLI).
 *
 * This is a HARDENING under iron rule 3 — the tool loses power and gains none.
 */
export async function retractFromAgent(args: {
  decisionId: string;
  reason: string;
  propose?: boolean;
}): Promise<string> {
  if (args.propose !== true) {
    throw new Error(
      `mai_retract is propose-only for agents: pass propose: true. ` +
        `Retracting a curated decision is the operator's call, so this tool files a ` +
        `proposal for their review queue instead — re-send as ` +
        `{ decision_id: "${args.decisionId}", reason: "<your evidence>", propose: true }. ` +
        `Nothing has been changed.`
    );
  }
  // THE SAME CHAR-LIMIT GUARD THE PATH THIS REPLACES PERFORMS. `decisionRetract`
  // opens with enforceCharLimits (decisions.ts:308) and Task 4 Step 5 re-points
  // mai_retract's MCP dispatch here — so without this line the agent arm would
  // accept a reason the tool rejects TODAY and write it unbounded into
  // curation_candidates.evidence, with no write_violations row. That would make
  // R6's "loses power and gains none" and §8's "adds ZERO bypass surface" false
  // (pass-4 finding c5768610). Dynamic import so this module's static import
  // list stays db.js + session-identity.js — the invariant the header pins.
  const { enforceCharLimits } = await import('./write-gate.js');
  await enforceCharLimits({ fields: { reason: args.reason }, toolName: 'mai_retract' });
  const reason = args.reason.trim();
  if (!reason) {
    throw new Error(
      `reason is required — a retraction proposal without stated evidence is not reviewable.`
    );
  }
  const projectId = await getProjectId();
  const pool = getPool();
  const target = await pool.query<{ id: string }>(
    `SELECT id FROM code_decisions WHERE id = $1 AND project_id = $2 AND still_valid = true`,
    [args.decisionId, projectId]
  );
  if (target.rows.length === 0) {
    return `No still-valid decision with id ${args.decisionId} in this project — nothing proposed.`;
  }
  // The partial unique index makes a re-proposal a NO-OP instead of a queue
  // flood — "make the race safe, not merely unlikely" (spec §4.2).
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO curation_candidates
       (project_id, target_kind, target_id, basis, evidence, proposed_by)
     VALUES ($1, 'decision', $2, 'agent-evidence', $3, $4)
     ON CONFLICT (project_id, target_kind, target_id) WHERE status = 'open'
     DO NOTHING
     RETURNING id`,
    [projectId, args.decisionId, reason, agentIdentity()]
  );
  if (inserted.rows.length === 0) {
    return `A retraction proposal for ${args.decisionId.slice(0, 8)} is already open — left as is. Nothing changed.`;
  }
  return (
    `Retraction PROPOSED for ${args.decisionId.slice(0, 8)} (candidate ${inserted.rows[0].id.slice(0, 8)}). ` +
    `The decision is untouched and still valid; the operator decides in mai_review.`
  );
}

// ---------- §5.1 operator verdicts (the ONLY mutating paths) ----------

/**
 * Retire one target INSIDE the caller's transaction (plan 22 ambiguity 7).
 *
 * Two properties, both load-bearing, both tested:
 * 1. `client` is always a transaction client — never the pool. The retire and
 *    the verdict bookkeeping that records it must land together or not at all,
 *    the same discipline `recordCitation` uses for the citation write.
 * 2. It returns `null` when there was nothing live to retire, so a verdict can
 *    never close a proposal it did not act on. Without this the routes mark a
 *    candidate `applied` even when the retire matched zero rows — a foreign or
 *    already-retired target would silently vanish from the operator's queue
 *    with nothing retired, which is a data-loss shape, not a cosmetic one.
 *    `decisionRetract` returns a "No decision with id …" MESSAGE rather than
 *    throwing, so a try/catch alone would not have caught it.
 */
/**
 * Best-effort graduated-rules re-render after a lesson-mutating verdict
 * (plan 27 R8): retiring/superseding a graduated lesson must drop its rule
 * from the rendered block without waiting for the next init/upgrade. Failures
 * are swallowed — the projection heals at any later render. Dynamic import:
 * this module's static import list stays db.js + session-identity.js (header).
 */
async function refreshGraduatedRules(projectId: string, kind: CuratedKind): Promise<void> {
  if (kind !== 'lesson') return;
  try {
    const { writeGraduatedRulesBlocks } = await import('./rules-render.js');
    await writeGraduatedRulesBlocks(projectId);
  } catch {
    // best-effort; the next render catches up
  }
}

async function lockLiveTarget(
  client: SqlRunner,
  projectId: string,
  kind: CuratedKind,
  id: string
): Promise<boolean> {
  if (kind === 'decision') {
    const live = await client.query<{ id: string }>(
      `SELECT id FROM code_decisions
        WHERE id = $1 AND project_id = $2
          AND still_valid = true AND retracted_at IS NULL
        FOR UPDATE`,
      [id, projectId]
    );
    return live.rows.length > 0;
  }
  const live = await client.query<{ id: string }>(
    `SELECT id FROM lessons
      WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)
        AND superseded_by IS NULL AND retired_at IS NULL
      FOR UPDATE`,
    [id, projectId]
  );
  return live.rows.length > 0;
}

async function retireTarget(
  client: SqlRunner,
  projectId: string,
  kind: CuratedKind,
  id: string,
  reason: string
): Promise<string | null> {
  if (!(await lockLiveTarget(client, projectId, kind, id))) return null;
  if (kind === 'decision') {
    const { decisionRetract } = await import('./decisions.js');
    return decisionRetract({ decisionId: id, reason, projectId, exec: client });
  }
  const { lessonRetire } = await import('./lessons.js');
  return lessonRetire(id, reason, projectId, client);
}

export async function curationKeep(args: {
  targetKind: CuratedKind;
  targetId: string;
  basis: CandidateBasis;
  note?: string;
  projectId: string;
}): Promise<string> {
  const pool = getPool();
  // An OPEN agent proposal for the same target resolves to 'kept' — the partial
  // unique index means there is at most one, and leaving it open would re-ask a
  // question the operator just answered.
  const resolved = await pool.query<{ id: string }>(
    `UPDATE curation_candidates
        SET status = 'kept', resolved_at = NOW(), resolved_note = $4
      WHERE project_id = $1 AND target_kind = $2 AND target_id = $3 AND status = 'open'
      RETURNING id`,
    [args.projectId, args.targetKind, args.targetId, args.note ?? null]
  );
  if (resolved.rows.length > 0) {
    return `Kept ${args.targetId.slice(0, 8)} — proposal ${resolved.rows[0].id.slice(0, 8)} closed. Nothing was retired.`;
  }
  const row = await pool.query<{ id: string }>(
    `INSERT INTO curation_candidates
       (project_id, target_kind, target_id, basis, status, resolved_at, resolved_note)
     VALUES ($1,$2,$3,$4,'kept',NOW(),$5)
     RETURNING id`,
    [args.projectId, args.targetKind, args.targetId, args.basis, args.note ?? null]
  );
  // "Keep" means keep, and don't ask again for another window — NOT keep
  // forever: an entry the brain has now carried for two unused windows is a
  // fair question to re-ask (spec §4.3).
  return (
    `Kept ${args.targetId.slice(0, 8)} (${args.basis}). Not asked again for ` +
    `${CURATION_WINDOW_DAYS} days — verdict ${row.rows[0].id.slice(0, 8)}.`
  );
}

export async function curationRetire(args: {
  targetKind: CuratedKind;
  targetId: string;
  reason: string;
  projectId: string;
}): Promise<string> {
  // ONE transaction: the retire and the verdict that records it commit together
  // or neither does (plan 22 ambiguity 7). A retire that matched nothing leaves
  // the proposal OPEN — the operator's question is only answered by an action
  // that actually happened.
  const client = await getPool().connect();
  let committed: { message: string; kind: CuratedKind } | undefined;
  try {
    await client.query('BEGIN');
    const message = await retireTarget(
      client, args.projectId, args.targetKind, args.targetId, args.reason
    );
    if (message === null) {
      await client.query('ROLLBACK');
      return (
        `No live ${args.targetKind} with id ${args.targetId.slice(0, 8)} in this project — ` +
        `nothing retired, and the proposal is left open.`
      );
    }
    await client.query(
      `UPDATE curation_candidates
          SET status = 'applied', resolved_at = NOW(), resolved_note = $4
        WHERE project_id = $1 AND target_kind = $2 AND target_id = $3 AND status = 'open'`,
      [args.projectId, args.targetKind, args.targetId, args.reason]
    );
    await client.query('COMMIT');
    committed = { message, kind: args.targetKind };
  } catch (err) {
    // AMENDMENT A6 (finding e438f908, recurrence of ab5a9f0e): a throwing
    // ROLLBACK must not replace the real failure on its way out.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (committed === undefined) {
    throw new Error('curationRetire committed without a result');
  }
  await refreshGraduatedRules(args.projectId, committed.kind);
  return committed.message;
}

export async function curationUnretire(args: {
  targetKind: CuratedKind;
  targetId: string;
  projectId: string;
}): Promise<string> {
  // Undo is ONE transaction too: restoring a target while leaving the agent's
  // proposal `applied` would hide the still-unanswered proposal forever.
  const client = await getPool().connect();
  let committed: { message: string; kind: CuratedKind } | undefined;
  try {
    await client.query('BEGIN');
    const lock = args.targetKind === 'decision'
      ? await client.query(
          `SELECT id FROM code_decisions
            WHERE id=$1 AND project_id=$2 AND still_valid=false FOR UPDATE`,
          [args.targetId, args.projectId])
      : await client.query(
          `SELECT id FROM lessons
            WHERE id=$1 AND (project_id=$2 OR project_id IS NULL)
              AND retired_at IS NOT NULL FOR UPDATE`,
          [args.targetId, args.projectId]);
    if (lock.rows.length === 0) {
      await client.query('ROLLBACK');
      return `No retired ${args.targetKind} ${args.targetId} in this project.`;
    }
    const message = args.targetKind === 'decision'
      ? await (await import('./decisions.js')).decisionUnretract(
          args.targetId, args.projectId, client)
      : await (await import('./lessons.js')).lessonUnretire(
          args.targetId, args.projectId, client);
    await client.query(
      `UPDATE curation_candidates
          SET status='open', resolved_at=NULL, resolved_note=NULL
        WHERE id=(
          SELECT id FROM curation_candidates
           WHERE project_id=$1 AND target_kind=$2 AND target_id=$3 AND status='applied'
             AND basis != 'graduate'
           ORDER BY resolved_at DESC NULLS LAST, created_at DESC LIMIT 1
        )`,
      [args.projectId, args.targetKind, args.targetId]
    );
    await client.query('COMMIT');
    committed = { message, kind: args.targetKind };
  } catch (err) {
    // AMENDMENT A6 (finding e438f908, recurrence of ab5a9f0e): a throwing
    // ROLLBACK must not replace the real failure on its way out.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (committed === undefined) {
    throw new Error('curationUnretire committed without a result');
  }
  await refreshGraduatedRules(args.projectId, committed.kind);
  return committed.message;
}

export async function curationApply(args: {
  citationId: string;
  note?: string;
  projectId: string;
}): Promise<string> {
  // Same ONE-transaction rule as curationRetire. Lock order is citation →
  // replacement → superseded target, so two operators serialize and neither
  // side can be withdrawn between the liveness decision and COMMIT.
  const client = await getPool().connect();
  let committed: { message: string; kind: CuratedKind } | undefined;
  try {
    await client.query('BEGIN');
    const row = await client.query<{
      citing_kind: string; citing_id: string | null;
      cited_kind: string; cited_id: string; reason: string;
    }>(
      `SELECT citing_kind, citing_id::text AS citing_id,
              cited_kind, cited_id::text AS cited_id, reason
         FROM memory_citations
        WHERE id = $1 AND project_id = $2 AND status = 'proposed'
        FOR UPDATE`,
      [args.citationId, args.projectId]
    );
    if (row.rows.length === 0) {
      await client.query('ROLLBACK');
      return `No open supersede proposal ${args.citationId} in this project.`;
    }
    const c = row.rows[0];
    if (c.citing_id === null ||
        !(await lockLiveTarget(client, args.projectId, toCuratedKind(c.citing_kind), c.citing_id))) {
      await client.query('ROLLBACK');
      return (
        `The replacement ${c.citing_kind} is no longer live — nothing retired, ` +
        `and the proposal is left open.`
      );
    }
    const reason = args.note?.trim() ? args.note.trim() : `Superseded — ${c.reason}`;
    const message = await retireTarget(
      client, args.projectId, toCuratedKind(c.cited_kind), c.cited_id, reason
    );
    if (message === null) {
      await client.query('ROLLBACK');
      return (
        `The superseded ${c.cited_kind} is no longer live — nothing retired, ` +
        `and the proposal is left open.`
      );
    }
    await client.query(
      `UPDATE memory_citations
          SET status = 'applied', resolved_at = NOW(), resolved_note = $2
        WHERE id = $1`,
      [args.citationId, reason]
    );
    await client.query('COMMIT');
    committed = { message, kind: toCuratedKind(c.cited_kind) };
  } catch (err) {
    // AMENDMENT A6 (finding e438f908, recurrence of ab5a9f0e): a throwing
    // ROLLBACK must not replace the real failure on its way out.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (committed === undefined) {
    throw new Error('curationApply committed without a result');
  }
  await refreshGraduatedRules(args.projectId, committed.kind);
  return committed.message;
}

export async function curationDismiss(args: {
  citationId: string;
  note?: string;
  projectId: string;
}): Promise<string> {
  const r = await getPool().query<{ id: string }>(
    `UPDATE memory_citations
        SET status = 'dismissed', resolved_at = NOW(), resolved_note = $3
      WHERE id = $1 AND project_id = $2 AND status = 'proposed'
      RETURNING id`,
    [args.citationId, args.projectId, args.note ?? null]
  );
  if (r.rows.length === 0) return `No open supersede proposal ${args.citationId} in this project.`;
  return `Dismissed supersede proposal ${r.rows[0].id.slice(0, 8)} — both entries live on.`;
}
/**
 * AMENDMENT A7 (plan 27, finding 7aca45df). The render outcome sentence, shared
 * by every verdict that reports one. It was inline in curationPromote while
 * curationUnpromote used the silent best-effort helper — so unpromote, the
 * command the rendered block itself names as THE removal path, reported success
 * identically whether the file was rewritten, skipped for want of a marker, or
 * failed on I/O. The DB projection is authoritative either way, but the operator
 * was told the rule was gone when it might still be on disk.
 */
async function renderReportNote(projectId: string): Promise<string> {
  try {
    const { writeGraduatedRulesBlocks } = await import('./rules-render.js');
    const lines = await writeGraduatedRulesBlocks(projectId);
    return lines.length > 0
      ? ` Rendered: ${lines.join('; ')}.`
      : ' No graduated-rules markers found in any registered repo — run mai upgrade to install them.';
  } catch (err) {
    return ` Render deferred (${err instanceof Error ? err.message : String(err)}) — heals at the next init/upgrade render.`;
  }
}

/**
 * Plan 27 §3: promote a graduated lesson to a project rule. A NEW verdict, not
 * curationApply — apply retires a memory (destructive); promote destroys
 * nothing (spec §3.2). One transaction writes the verdict; the render runs
 * AFTER COMMIT, best-effort — an unreachable repo logs into the message and
 * heals at the next init/upgrade render (decision cd9e4009).
 */
export async function curationPromote(args: {
  lessonId: string;
  note?: string;
  projectId: string;
}): Promise<string> {
  const client = await getPool().connect();
  let promotedRule = '';
  try {
    await client.query('BEGIN');
    const live = await client.query<{ id: string; rule: string; relearned_count: number }>(
      `SELECT id, rule, relearned_count FROM lessons
        WHERE id = $1 AND project_id = $2
          AND superseded_by IS NULL AND retired_at IS NULL
        FOR UPDATE`,
      [args.lessonId, args.projectId]
    );
    if (live.rows.length === 0) {
      await client.query('ROLLBACK');
      return (
        `No live project-local lesson with id ${args.lessonId.slice(0, 8)} in this project — ` +
        `nothing promoted. (Global lessons never graduate — plan 27 §4.)`
      );
    }
    const relearned = Number(live.rows[0].relearned_count);
    if (relearned < GRADUATION_REINFORCEMENTS) {
      await client.query('ROLLBACK');
      return (
        `Lesson ${args.lessonId.slice(0, 8)} is at relearned ×${relearned}, below the graduation ` +
        `threshold (${GRADUATION_REINFORCEMENTS}) — nothing promoted.`
      );
    }
    const dupe = await client.query(
      `SELECT 1 FROM curation_candidates
        WHERE project_id = $1 AND target_kind = 'lesson' AND target_id = $2
          AND basis = 'graduate' AND status = 'applied'`,
      [args.projectId, args.lessonId]
    );
    if (dupe.rows.length > 0) {
      await client.query('ROLLBACK');
      return `Lesson ${args.lessonId.slice(0, 8)} is already a promoted rule — nothing changed.`;
    }
    await client.query(
      `INSERT INTO curation_candidates
         (project_id, target_kind, target_id, basis, status, resolved_at, resolved_note)
       VALUES ($1, 'lesson', $2, 'graduate', 'applied', NOW(), $3)`,
      [args.projectId, args.lessonId, args.note ?? null]
    );
    await client.query('COMMIT');
    promotedRule = live.rows[0].rule;
  } catch (err) {
    // AMENDMENT A6 (finding e438f908, recurrence of ab5a9f0e): a throwing
    // ROLLBACK must not replace the real failure on its way out.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return (
    `Promoted lesson ${args.lessonId.slice(0, 8)} to project rule: "${promotedRule}".` +
    (await renderReportNote(args.projectId))
  );
}

/**
 * Plan 27 §3.4 deny: "Not a rule" — a `dismissed` graduate verdict, suppressed
 * from re-proposal for one CURATION_WINDOW_DAYS window by the candidacy
 * predicate. The lesson itself is untouched and stays live.
 */
export async function curationReject(args: {
  lessonId: string;
  note?: string;
  projectId: string;
}): Promise<string> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const live = await client.query<{ id: string }>(
      `SELECT id FROM lessons
        WHERE id = $1 AND project_id = $2
          AND superseded_by IS NULL AND retired_at IS NULL
        FOR UPDATE`,
      [args.lessonId, args.projectId]
    );
    if (live.rows.length === 0) {
      await client.query('ROLLBACK');
      return (
        `No live project-local lesson with id ${args.lessonId.slice(0, 8)} in this project — ` +
        `nothing recorded.`
      );
    }
    const row = await client.query<{ id: string }>(
      `INSERT INTO curation_candidates
         (project_id, target_kind, target_id, basis, status, resolved_at, resolved_note)
       VALUES ($1, 'lesson', $2, 'graduate', 'dismissed', NOW(), $3)
       RETURNING id`,
      [args.projectId, args.lessonId, args.note ?? null]
    );
    await client.query('COMMIT');
    return (
      `Not a rule — graduation of ${args.lessonId.slice(0, 8)} declined; not proposed again for ` +
      `${CURATION_WINDOW_DAYS} days (verdict ${row.rows[0].id.slice(0, 8)}). The lesson lives on.`
    );
  } catch (err) {
    // AMENDMENT A6 (finding e438f908, recurrence of ab5a9f0e): a throwing
    // ROLLBACK must not replace the real failure on its way out.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Operator-only removal of the rendered rule. The lesson remains live and
 * relearned_count is untouched. The newest applied verdict is locked and
 * changed to dismissed, so candidacy is suppressed for the normal window and
 * can legitimately return later. No MCP or web route exposes this operation. */
export async function curationUnpromote(args: {
  lessonId: string;
  note: string;
  projectId?: string;
}): Promise<string> {
  const projectId = args.projectId ?? (await getProjectId());
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const verdict = await client.query<{ id: string }>(
      `SELECT id FROM curation_candidates
        WHERE project_id = $1 AND target_kind = 'lesson' AND target_id = $2
          AND basis = 'graduate' AND status = 'applied'
        ORDER BY resolved_at DESC NULLS LAST, id DESC
        LIMIT 1 FOR UPDATE`,
      [projectId, args.lessonId]
    );
    if (verdict.rows.length === 0) {
      await client.query('ROLLBACK');
      return `Lesson ${args.lessonId.slice(0, 8)} has no applied graduation verdict — nothing changed.`;
    }
    await client.query(
      `UPDATE curation_candidates
          SET status = 'dismissed', resolved_at = NOW(), resolved_note = $3
        WHERE id = $1 AND project_id = $2`,
      [verdict.rows[0].id, projectId, args.note]
    );
    await client.query('COMMIT');
  } catch (err) {
    // AMENDMENT A6 (finding e438f908, recurrence of ab5a9f0e): a throwing
    // ROLLBACK must not replace the real failure on its way out.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const renderNote = await renderReportNote(projectId);
  return (
    `Unpromoted lesson ${args.lessonId.slice(0, 8)}; the lesson remains live and may be proposed ` +
    `again after the curation window.${renderNote}`
  );
}

export async function curationRecount(projectIdOverride?: string): Promise<string> {
  const projectId = projectIdOverride ?? (await getProjectId());
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const decisions = await client.query(
      `WITH totals AS (
         SELECT d2.id, count(mc.id)::int AS cited_count, max(mc.created_at) AS last_cited_at
           FROM code_decisions d2
           LEFT JOIN memory_citations mc
             ON mc.cited_kind='decision' AND mc.cited_id=d2.id AND mc.project_id=$1
          WHERE d2.project_id=$1
          GROUP BY d2.id
       )
       UPDATE code_decisions d
          SET cited_count = COALESCE(t.cited_count, 0),
              last_cited_at = t.last_cited_at
         FROM totals t WHERE d.id=t.id
       RETURNING d.id`,
      [projectId]
    );
    const lessons = await client.query(
      `WITH totals AS (
         SELECT l2.id, count(mc.id)::int AS cited_count, max(mc.created_at) AS last_cited_at
           FROM lessons l2
           LEFT JOIN memory_citations mc
             ON mc.cited_kind='lesson' AND mc.cited_id=l2.id
            AND (l2.project_id IS NULL OR mc.project_id=$1)
          WHERE l2.project_id=$1 OR l2.project_id IS NULL
          GROUP BY l2.id
       )
       UPDATE lessons l
          SET cited_count = COALESCE(t.cited_count, 0),
              last_cited_at = t.last_cited_at
         FROM totals t WHERE l.id=t.id
       RETURNING l.id`,
      [projectId]
    );
    await client.query('COMMIT');
    return `Recounted ${decisions.rowCount ?? 0} decisions and ${lessons.rowCount ?? 0} lessons from memory_citations.`;
  } catch (err) {
    // AMENDMENT A6 (finding e438f908, recurrence of ab5a9f0e): a throwing
    // ROLLBACK must not replace the real failure on its way out.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
