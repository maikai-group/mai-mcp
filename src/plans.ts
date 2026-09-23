// Plan/review/finding records (spec 2026-08-09). Plans are identified by a
// stable row; the .md file stays authoritative for CONTENT. Findings carry a
// status the EXECUTOR transitions, and embeddings so a later review can ask
// "has something like this been found before?" — the recall this exists for.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPool, getProjectId } from './db.js';
import { recordFindingReferences } from './curation.js';
// Session/agent identity has exactly one home (review B2/B3). MAI_SESSION_ID
// does not exist — INSTANCE_SESSION is "the only session identity MCP
// provides", and agentIdentity() already wraps MAI_AGENT_ID. Re-inlining
// either would be a second source of truth that drifts. The file lives in
// core (Step 0 moved it out of coordination/ — pass-2 W3): importing a
// coordination SUBMODULE from core would bypass the coordination-api facade.
import { agentIdentity, INSTANCE_SESSION } from './session-identity.js';
// TYPE-only import of the seam's own declaration file — coordination-api.ts IS
// the core-side contract, so this does not reach into coordination/ (the
// implementation is fetched through the facade instance below, dynamically,
// exactly as src/prime.ts:5 reaches it).
import type { PlanThreadRef } from './coordination-api.js';
import type { PoolClient } from 'pg';
import type { OperatorTaskSyncReceipt } from './operator-tasks.js';
// The read-budget leaf imports nothing (plan 23 R1), so this stays acyclic.
import {
  budgetPage, budgetSections, budgetText, headlineField, pageBudget,
  type ReadBudget, type ReadSection,
} from './read-budget.js';
import { findingCandidate, MAI_SHADOW_CHAR_CAP, planCandidate } from './token-mai-shadow.js';
import type { FindingShadowIdentity, MaiShadowDraft } from './token-mai-shadow.js';

export type PlanStatus =
  | 'draft' | 'reviewing' | 'approved' | 'executing' | 'executed' | 'abandoned';
export type ReviewKind = 'author' | 'blind';
export type ReviewVerdict = 'approved' | 'blocked';
export type FindingSeverity = 'blocker' | 'warning' | 'note';
export type FindingStatus = 'open' | 'fixed' | 'disputed' | 'accepted-risk';

export const PLAN_STATUSES: PlanStatus[] =
  ['draft', 'reviewing', 'approved', 'executing', 'executed', 'abandoned'];
export const FINDING_STATUSES: FindingStatus[] =
  ['open', 'fixed', 'disputed', 'accepted-risk'];

/** `none` is internal-only (plan 23 R5): a status WRITE returns metadata,
 * finding counts and pointers with zero synthesis, whatever the caller asked
 * for. It is deliberately absent from PASSES_MODES so it can never be sent. */
export type PassesMode = 'latest' | 'all' | 'none';
export const PASSES_MODES: Array<Exclude<PassesMode, 'none'>> = ['latest', 'all'];

export interface PlanRow {
  id: string; project_id: string; slug: string; path: string; title: string;
  current_sha: string | null; status: PlanStatus;
}

export interface FindingRow {
  /** Which table the row came from. Selected as a SQL literal by every query
   * that produces a FindingRow — pg does not typecheck results against this
   * generic, so a query that forgets the literal yields `undefined` under a
   * non-optional type. All six sites in findingsQuery select it (Step 2). */
  kind: 'plan' | 'code';
  id: string; plan_id: string | null; ref: string | null; severity: FindingSeverity;
  title: string; location: string; issue: string; evidence: string; fix: string;
  status: FindingStatus; resolution_note: string | null; created_at: Date | string;
}

export interface FindingInput {
  ref?: string; severity: FindingSeverity; title: string; location: string;
  issue: string; evidence: string; fix: string; recurrence_of?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Derive a stable slug from a plan filename: strip the leading date and the
 * extension. `2026-08-09-plan-16-findings-tracker.md` → `plan-16-findings-tracker`. */
export function slugFromPath(p: string): string {
  return path.basename(p, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/** The project's registered root, canonicalized once (plan 20): a trailing
 * slash on the registered root breaks naive prefix logic (init stores
 * args.root verbatim and accepts `/x/y/`), so every consumer must judge
 * containment against the SAME realpath'd string. Null = no registered root.
 * This is also the `repo_root` doc chunks store for anything inside it. */
export async function projectRootReal(projectId: string): Promise<string | null> {
  const row = await getPool().query<{ path: string | null }>(
    `SELECT path FROM projects WHERE id = $1`, [projectId]
  );
  const root = row.rows[0]?.path;
  if (!root) return null;
  return await fs.realpath(path.resolve(root)).catch(() => path.resolve(root));
}

/** Containment + symlink bound for ONE already-realpath'd root — the single
 * implementation behind both `resolvePlanPath` (root = projects.path) and the
 * docs sweep, which applies it per REGISTERED REPO (plan 20, finding
 * 2481fa65: spec §2 covers every registered repo, and each root deserves the
 * same check). A symlink inside the tree can physically point outside it, so
 * the resolved path is realpath'd before the relative test; an unresolvable
 * path falls back to its lexical form so the loud cannot-read-file error stays
 * downstream (shaOfFile), not here. Returns null when the path is absolute or
 * escapes — callers phrase their own error (mai_plan's wording is test-pinned). */
export async function resolveUnderRoot(rootReal: string, relPath: string): Promise<string | null> {
  if (path.isAbsolute(relPath)) return null;
  const lex = path.resolve(rootReal, relPath);
  const abs = await fs.realpath(lex).catch(() => lex);
  const rel = path.relative(rootReal, abs);
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) {
    return null;
  }
  return abs;
}

/** Resolve a repo-relative plan path against the PROJECT'S registered root —
 * never the server's cwd, which is the consumer project and not necessarily
 * where the plan lives (spec §6). Repo-relative is the CONTRACT (pass-3 B5):
 * absolute paths are refused, and a resolved path must stay inside the root —
 * otherwise mai_plan can read and register files outside the pinned project.
 * Known bound (pass-2 N4, accepted): resolution uses `projects.path` — the
 * umbrella root. A plan living inside a multi-repo project's nested
 * sub-repository (metadata.repos) resolves via its umbrella-relative path,
 * e.g. `backend/docs/plan.md`; per-sub-repo roots stay out of scope FOR THIS
 * TOOL (the plan-20 docs sweep does scan them, via resolveUnderRoot). */
export async function resolvePlanPath(projectId: string, relPath: string): Promise<string> {
  if (path.isAbsolute(relPath)) {
    throw new Error(
      `Plan paths are repo-relative (resolved against the project root) — got absolute '${relPath}'.`
    );
  }
  const rootReal = await projectRootReal(projectId);
  if (!rootReal) {
    throw new Error(
      `Project has no registered root path — cannot resolve '${relPath}'. Run \`mai init\` for this project.`
    );
  }
  const abs = await resolveUnderRoot(rootReal, relPath);
  if (abs === null) {
    throw new Error(`'${relPath}' escapes the project root — refusing the traversal.`);
  }
  return abs;
}

async function shaOfFile(abs: string, relPath: string): Promise<string> {
  try {
    const buf = await fs.readFile(abs);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    // A plan record whose file cannot be read is worse than no record
    // (spec §6): fail loudly rather than storing a silent NULL.
    throw new Error(`Cannot read plan file at '${relPath}' (resolved: ${abs}).`);
  }
}

export interface PlanRegisterArgs {
  path: string; slug?: string; title?: string; status?: PlanStatus;
  passes?: Exclude<PassesMode, 'none'>; reviewPass?: number;
}

export interface ReviewHeader {
  pass: number; kind: ReviewKind; verdict: ReviewVerdict; reviewer_agent: string;
  plan_sha: string | null; synthesis: string; created_at: Date | string;
}

export interface PlanSummary extends PlanRow {
  findings: { open_blockers: number; open_warnings: number; total: number };
  /** Total posted passes regardless of the `passes` scope — the render's
   * earlier-pass pointer needs the full count even when `reviews` carries
   * only the latest (plan 17 R2). */
  review_count: number;
  /** Posted passes, oldest first, WITH synthesis (plan 16 R1: reviews are
   * readable back — a clean zero-finding approval must be visible after
   * posting). Scope (plan 23 R5/R6): the newest pass by default; the one
   * explicitly selected pass under `reviewPass`; every pass under
   * `passes: 'all'`; none at all on a status write. The synthesis itself is
   * never truncated at the source — only paged at the MCP boundary. */
  reviews: ReviewHeader[];
  operator_tasks?: OperatorTaskSyncReceipt;
}

async function consolidatePlanAliases(
  client: PoolClient, survivor: PlanRow, losers: readonly PlanRow[],
): Promise<void> {
  if (losers.length === 0) return;
  const planIds = [survivor.id, ...losers.map((loser) => loser.id)];
  await client.query(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS ordinal
         FROM plan_reviews
        WHERE plan_id = ANY($1::uuid[])
     )
     UPDATE plan_reviews review
        SET pass = -ordered.ordinal
       FROM ordered
      WHERE review.id = ordered.id`,
    [planIds]
  );
  for (const loser of losers) {
    const collision = await client.query<{ task_key: string }>(
      `SELECT loser.task_key
         FROM operator_tasks loser
         JOIN operator_tasks survivor
           ON survivor.plan_id = $1 AND survivor.source_kind = 'plan'
          AND survivor.task_key = loser.task_key
        WHERE loser.plan_id = $2 AND loser.source_kind = 'plan'
        LIMIT 1`,
      [survivor.id, loser.id]
    );
    if (collision.rows[0]) {
      throw new Error(
        `Cannot consolidate plan aliases: operator task key '${collision.rows[0].task_key}' exists on both plans.`
      );
    }
    await client.query(
      `UPDATE plan_reviews SET plan_id = $1 WHERE plan_id = $2`,
      [survivor.id, loser.id]
    );
    await client.query(`UPDATE plan_findings SET plan_id = $1 WHERE plan_id = $2`, [survivor.id, loser.id]);
    await client.query(`UPDATE code_findings SET plan_id = $1 WHERE plan_id = $2`, [survivor.id, loser.id]);
    await client.query(
      `UPDATE operator_tasks
          SET plan_id = $1,
              source_plan_slug = CASE WHEN source_kind = 'plan' THEN $3 ELSE NULL END
        WHERE plan_id = $2`,
      [survivor.id, loser.id, survivor.slug]
    );
    await client.query(`DELETE FROM plans WHERE id = $1`, [loser.id]);
  }
  await client.query(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS ordinal
         FROM plan_reviews
        WHERE plan_id = $1
     )
     UPDATE plan_reviews review
        SET pass = ordered.ordinal
       FROM ordered
      WHERE review.id = ordered.id`,
    [survivor.id]
  );
}

/**
 * Register or fetch a plan, idempotently. Resolution order (spec §6):
 * existing row for (project, path) → else existing row for (project, slug),
 * updating its path so a rename does not orphan findings → else insert.
 */
export async function planRegister(args: PlanRegisterArgs): Promise<PlanSummary> {
  assertEnum('status', args.status, PLAN_STATUSES);
  assertEnum('passes', args.passes, PASSES_MODES);
  const pool = getPool();
  const projectId = await getProjectId();
  const abs = await resolvePlanPath(projectId, args.path);
  const repoRoot = await projectRootReal(projectId);
  if (!repoRoot) { // resolvePlanPath already throws this; keeps the type honest
    throw new Error(
      `Project has no registered root path — cannot resolve '${args.path}'. Run \`mai init\` for this project.`
    );
  }
  // One physical file, one tracker/chunk identity. resolvePlanPath has already
  // realpath'd aliases/symlinks and proved containment (finding 6c2cd767).
  const canonicalPath = path.relative(repoRoot, abs);
  const slug = args.slug ?? slugFromPath(canonicalPath);
  const sha = await shaOfFile(abs, canonicalPath);

  if (args.status === 'executing') {
    const client = await pool.connect();
    let updated: PlanRow;
    let previousPath: string;
    let operatorTasks: OperatorTaskSyncReceipt;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${projectId}:${canonicalPath}`]
      );
      const candidates = await client.query<PlanRow>(
        `SELECT id, project_id, slug, path, title, current_sha, status
           FROM plans WHERE project_id = $1 ORDER BY id FOR UPDATE`, [projectId]
      );
      const physical: PlanRow[] = [];
      for (const candidate of candidates.rows) {
        const candidateAbs = await resolveUnderRoot(repoRoot, candidate.path);
        if (candidateAbs === abs) physical.push(candidate);
      }
      physical.sort((a, b) => {
        const rank = (p: PlanRow): number =>
          p.path === canonicalPath ? 0 : p.path === args.path ? 1 : 2;
        return rank(a) - rank(b) || a.id.localeCompare(b.id);
      });
      if (physical.length === 0) {
        throw new Error(`Plan '${canonicalPath}' must be registered, reviewed, and approved before executing.`);
      }
      const survivor = physical[0];
      const losers = physical.slice(1);
      await consolidatePlanAliases(client, survivor, losers);
      if (survivor.status !== 'approved' && survivor.status !== 'executing') {
        throw new Error(`Plan '${canonicalPath}' must be approved before executing (status=${survivor.status}).`);
      }
      const { syncPlanOperatorTasks } = await import('./operator-tasks.js');
      operatorTasks = await syncPlanOperatorTasks({ plan: survivor.id, expectedSha: sha, client });
      const result = await client.query<PlanRow>(
        `UPDATE plans
            SET path = $3, title = COALESCE($4, title), current_sha = $5,
                status = 'executing', updated_at = now()
          WHERE id = $1 AND project_id = $2 AND status IN ('approved','executing')
          RETURNING id, project_id, slug, path, title, current_sha, status`,
        [survivor.id, projectId, canonicalPath, args.title ?? null, sha]
      );
      if (!result.rows[0]) throw new Error(`Plan '${canonicalPath}' changed while execution was starting.`);
      previousPath = survivor.path;
      updated = result.rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await chunkRegisteredPlan(projectId, updated, abs, previousPath);
    return { ...(await planSummary(updated, ...summaryScope(args))), operator_tasks: operatorTasks };
  }

  // Every registration path that can insert or retarget a plan participates
  // in the same physical-file lock protocol as execution start. Lock existing
  // rows BEFORE resolving their paths; the advisory key prevents a symlink or
  // lexical alias of this same file from becoming a phantom insert meanwhile.
  const client = await pool.connect();
  let stored: PlanRow;
  let previousPath: string | null;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${projectId}:${canonicalPath}`]
    );
    const candidates = await client.query<PlanRow>(
      `SELECT id, project_id, slug, path, title, current_sha, status
         FROM plans WHERE project_id = $1 ORDER BY id FOR UPDATE`, [projectId]
    );
    const physical: PlanRow[] = [];
    for (const candidate of candidates.rows) {
      const candidateAbs = await resolveUnderRoot(repoRoot, candidate.path);
      if (candidateAbs === abs) physical.push(candidate);
    }
    physical.sort((a, b) => {
      const rank = (p: PlanRow): number =>
        p.path === canonicalPath ? 0 : p.path === args.path ? 1 : 2;
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
    let row = physical[0]
      ?? candidates.rows.find((candidate) => candidate.path === canonicalPath)
      ?? candidates.rows.find((candidate) => candidate.slug === slug);

    // A pre-enforcement symlink/case alias may have a different default slug,
    // and more than one alias row may already exist. Preserve one deterministic
    // UUID and move every dependent review/finding/task inside this transaction.
    if (row && physical.length > 1) {
      await consolidatePlanAliases(client, row, physical.slice(1));
    }

    previousPath = row?.path ?? null;
    if (row) {
      // The idempotent fetch must not CLOBBER: title changes only when supplied.
      const updated = await client.query<PlanRow>(
        `UPDATE plans
            SET path = $3, title = COALESCE($4, title), current_sha = $5,
                status = COALESCE($6, status), updated_at = now()
          WHERE id = $1 AND project_id = $2
          RETURNING id, project_id, slug, path, title, current_sha, status`,
        [row.id, projectId, canonicalPath, args.title ?? null, sha, args.status ?? null]
      );
      if (!updated.rows[0]) throw new Error(`Plan '${canonicalPath}' changed while registration was updating.`);
      stored = updated.rows[0];
    } else {
      const inserted = await client.query<PlanRow>(
        `INSERT INTO plans (project_id, slug, path, title, current_sha, status)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'draft'))
         RETURNING id, project_id, slug, path, title, current_sha, status`,
        [projectId, slug, canonicalPath, args.title ?? slug, sha, args.status ?? null]
      );
      stored = inserted.rows[0];
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await chunkRegisteredPlan(projectId, stored, abs, previousPath);
  return planSummary(stored, ...summaryScope(args));
}

/** R5: a status WRITE returns zero synthesis regardless of which history
 * selector rode along — the selector is dropped, not merely overruled, so a
 * write can never be turned into a review dump. A plain fetch defaults to the
 * newest pass (R6); an explicit pass wins over the default. */
function summaryScope(args: PlanRegisterArgs): [PassesMode, number | undefined] {
  if (args.status !== undefined) return ['none', undefined];
  return [args.passes ?? 'latest', args.reviewPass];
}

/** Chunk+embed the registered plan doc (plan 20, spec §3): register and
 * SHA-refresh both land here — rechunkDoc's doc_sha check makes the unchanged
 * case one file read + one SELECT. BEST-EFFORT by design: chunks are derived
 * data (spec §8 — they assert nothing), so a chunking failure warns and never
 * fails registration; the ingest-chain sweep self-heals on the next session
 * end. Harness-agnostic by construction: any MCP-speaking agent that calls
 * mai_plan triggers it (spec §3 — Codex reviews already arrive this way). */
async function chunkRegisteredPlan(
  projectId: string,
  plan: PlanRow,
  abs: string,
  previousPath: string | null
): Promise<void> {
  try {
    // repo_root for a registered plan is always the project root: plans.path
    // is project-root-relative by contract, so this identity matches what the
    // sweep computes for the same file (plan 20 ambiguity 1).
    const repoRoot = await projectRootReal(projectId);
    if (!repoRoot) return; // unreachable via planRegister (resolvePlanPath already threw)
    const { deleteDocChunks, rechunkDoc } = await import('./doc-chunks.js');
    // Upgrade derived rows created before canonical-path enforcement. This
    // also cleans an ordinary same-slug rename. Delete is intentionally in
    // the best-effort envelope: tracker registration remains authoritative.
    if (previousPath !== null && previousPath !== plan.path) {
      await deleteDocChunks(projectId, repoRoot, previousPath);
    }
    await rechunkDoc({
      projectId, repoRoot, path: plan.path, absPath: abs, kind: 'plan', planId: plan.id,
    });
  } catch (err) {
    console.warn(
      `[mai-docs] chunking failed for ${plan.path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Derived board notes are hard-capped WELL under FIELD_CHAR_LIMIT (1000 —
 * src/write-gate.ts:40). enforceCharLimits does not merely reject an oversize
 * body: it writes a write_violations row (src/write-gate.ts:336-347), which
 * would turn a notification into a gate violation. Capping here makes that
 * structurally impossible rather than merely unlikely (plan 21 §3.4/§8). */
const NOTE_CHAR_CAP = 900;

export function capNoteBody(body: string): string {
  return body.length <= NOTE_CHAR_CAP ? body : body.slice(0, NOTE_CHAR_CAP - 1) + '…';
}

/** The §3.4 verdict body. PURE — unit-testable without a DB. Deliberately
 * carries NO synthesis: it is routinely thousands of chars, and the pointer to
 * mai_plan is the product (the synthesis is already readable back there —
 * plan 16 R1, src/plans.ts:872-878). sanitizeBody flattens newlines anyway,
 * so this is composed as one line. */
export function formatVerdictNote(a: {
  pass: number;
  kind: ReviewKind;
  verdict: ReviewVerdict;
  slug: string;
  planSha: string | null;
  openBlockers: number;
  openWarnings: number;
  path: string;
}): string {
  const sha = a.planSha ? ` @ ${a.planSha.slice(0, 8)}` : '';
  return capNoteBody(
    `pass ${a.pass} [${a.kind}/${a.verdict}] on ${a.slug}${sha} — ` +
      `${a.openBlockers} blocker(s), ${a.openWarnings} warning(s) open. ` +
      `Read: mai_plan {path:"${a.path}"}`
  );
}

interface DerivedPlanNote {
  body: string;
  refs: PlanThreadRef[];
}

type LifecyclePostRevalidator = (client: PoolClient) => Promise<DerivedPlanNote | null>;
type LifecycleRetractRevalidator = (client: PoolClient) => Promise<boolean>;

/**
 * Post ONE derived note into a plan's board thread, opening the thread on first
 * use and persisting its root. The structured result distinguishes posted,
 * suppressed, and a stale guarded transition (plan 21 §4.5). This is the ONE delivery surface both bridges share — Bridge
 * B has no surface of its own, which is exactly why spec §10 merges the two
 * halves into one plan.
 *
 * The plan row, optional approved→executing transition, board write and root
 * write-back share one project-scoped transaction under a per-plan advisory
 * lock. Coordination is reached through the FACADE INSTANCE only: importing a
 * coordination submodule from core would bypass the seam (src/plans.ts:9-15).
 * The import is dynamic, matching the house pattern already used here for
 * embeddings and doc-chunks.
 */
export async function postPlanNote(
  planId: string,
  body: string,
  refs: PlanThreadRef[],
  options: {
    transitionApprovedToExecuting?: boolean;
    reviewPass?: number;
    lifecycleRevalidate?: LifecyclePostRevalidator;
  } = {}
): Promise<{
  delivery: 'posted' | 'suppressed' | 'stale';
  transitioned: boolean;
  operator_tasks?: OperatorTaskSyncReceipt;
}> {
  const pool = getPool();
  const projectId = await getProjectId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Project id is part of the lock key, matching the pin wall. The lock is
    // belt-and-braces with FOR UPDATE and is independently mutation-pinned.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${projectId}:${planId}`]
    );
    // A lifecycle decision depends on four independently-written relations.
    // Lock them AFTER the advisory lock but BEFORE the plan row: an advisory
    // waiter holds no evidence/row lock (so the barrier tests can commit the
    // competing state), while writers that already hold a relation lock can
    // still finish their later plan-row work before this transaction takes it.
    // The post-lock re-derivation then stays true through COMMIT. Bridge A has
    // no lifecycle callback and pays none of this serialization cost.
    if (options.lifecycleRevalidate) {
      await client.query(
        `LOCK TABLE plan_reviews, plan_findings, code_commits, commit_files IN SHARE MODE`
      );
    }
    const row = await client.query<{
      board_thread_id: string | null; status: PlanStatus; current_sha: string | null;
    }>(
      `SELECT board_thread_id, status, current_sha FROM plans
        WHERE id = $1 AND project_id = $2
        FOR UPDATE`,
      [planId, projectId]
    );
    const plan = row.rows[0];
    if (!plan) throw new Error(`plan ${planId} not found in pinned project`);

    // Bridge A commits before notifying. A delayed older pass must not be able
    // to acquire this lock later and supersede the newest committed verdict.
    if (options.reviewPass !== undefined) {
      const latest = await client.query<{ pass: number }>(
        `SELECT COALESCE(max(pass), 0)::int AS pass FROM plan_reviews WHERE plan_id = $1`,
        [planId]
      );
      if (options.reviewPass !== latest.rows[0].pass) {
        await client.query('ROLLBACK');
        return { delivery: 'stale', transitioned: false };
      }
    }

    let currentNote: DerivedPlanNote = { body, refs };
    if (options.lifecycleRevalidate) {
      const derived = await options.lifecycleRevalidate(client);
      if (!derived) {
        await client.query('ROLLBACK');
        return { delivery: 'stale', transitioned: false };
      }
      currentNote = derived;
    }

    let transitioned = false;
    let operatorTasks: OperatorTaskSyncReceipt | undefined;
    if (options.transitionApprovedToExecuting) {
      if (plan.status !== 'approved') {
        await client.query('ROLLBACK');
        return { delivery: 'stale', transitioned: false };
      }
      if (plan.current_sha === null) throw new Error(`plan ${planId} has no current SHA`);
      const { syncPlanOperatorTasks } = await import('./operator-tasks.js');
      operatorTasks = await syncPlanOperatorTasks({
        plan: planId, expectedSha: plan.current_sha, client,
      });
      const updated = await client.query(
        `UPDATE plans SET status = 'executing', updated_at = now()
          WHERE id = $1 AND project_id = $2 AND status = 'approved'`,
        [planId, projectId]
      );
      if (!updated.rowCount || updated.rowCount === 0) {
        await client.query('ROLLBACK');
        return { delivery: 'stale', transitioned: false };
      }
      transitioned = true;
    }

    const { coordination } = await import('./coordination/index.js');
    const delivered = await coordination.postPlanThreadNote(
      { threadId: plan.board_thread_id, body: currentNote.body, refs: currentNote.refs },
      client
    );
    // Self-healing write-back shares the same project-scoped transaction as
    // suppression/post/supersede and the optional lifecycle transition. A
    // structured suppression carries the surviving root, so a recreated plan
    // row cannot remain detached from its legitimate derived history.
    if (delivered.threadRoot !== plan.board_thread_id) {
      await client.query(
        `UPDATE plans SET board_thread_id = $3
          WHERE id = $1 AND project_id = $2`,
        [planId, projectId, delivered.threadRoot]
      );
    }
    await client.query('COMMIT');
    // Suppression is safe for a guarded flip only because both suppression
    // arms prove the identical durable note already exists. The distinct
    // duplicate-unresolvable outcome throws in board.ts and reaches rollback.
    return { delivery: delivered.delivery, transitioned, operator_tasks: operatorTasks };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Retract only an obsolete server-derived lifecycle prompt. Keeps the thread
 * root/history and never posts a finding-transition message. */
export async function retractPlanNote(
  planId: string,
  slug: string,
  planPath: string,
  lifecycleRevalidate?: LifecycleRetractRevalidator
): Promise<boolean> {
  const pool = getPool();
  const projectId = await getProjectId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${projectId}:${planId}`]
    );
    if (lifecycleRevalidate) {
      await client.query(
        `LOCK TABLE plan_reviews, plan_findings, code_commits, commit_files IN SHARE MODE`
      );
    }
    const row = await client.query<{ board_thread_id: string | null }>(
      `SELECT board_thread_id FROM plans WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [planId, projectId]
    );
    if (!row.rows[0]) throw new Error(`plan ${planId} not found in pinned project`);
    if (lifecycleRevalidate && !(await lifecycleRevalidate(client))) {
      await client.query('ROLLBACK');
      return false;
    }
    const { coordination } = await import('./coordination/index.js');
    const retracted = await coordination.retractPlanThreadNote({
      threadId: row.rows[0].board_thread_id,
      bodyPrefix: `${slug} — `,
      bodySuffixes: [
        `Mark executing? mai_plan {path:"${planPath}", status:"executing"}`,
        `Mark executed? mai_plan {path:"${planPath}", status:"executed"}`,
      ],
    }, client);
    await client.query('COMMIT');
    return retracted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let beforeVerdictDeliveryForTests: ((pass: number) => Promise<void>) | null = null;

/** Test-only: deterministically delay one committed verdict before its lock. */
export function _setBeforeVerdictDeliveryForTests(
  hook: ((pass: number) => Promise<void>) | null
): void {
  beforeVerdictDeliveryForTests = hook;
}

/** Bridge A (plan 21 §3.1). Runs AFTER reviewPostOnce returns, never inside its
 * transaction: losing a posted review is spec §12 failure #4, the exact thing
 * the tracker exists to prevent, and a board insert must never be able to roll
 * one back. Best-effort — a failure appends to the result's warnings (which
 * mai_review_post already renders, src/index.ts:303) and never throws. */
async function notifyVerdict(
  plan: PlanRow,
  args: ReviewPostArgs,
  pass: number,
  reviewedSha: string,
  warnings: string[]
): Promise<void> {
  try {
    // Counts are read HERE, after the review committed — reviewPost never calls
    // planSummary (that is planRegister's path), and the note must describe the
    // post-review state.
    const c = await getPool().query<{ open_blockers: string; open_warnings: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'open' AND severity = 'blocker') AS open_blockers,
         count(*) FILTER (WHERE status = 'open' AND severity = 'warning') AS open_warnings
       FROM plan_findings WHERE plan_id = $1`,
      [plan.id]
    );
    const body = formatVerdictNote({
      pass,
      kind: args.kind,
      verdict: args.verdict,
      slug: plan.slug,
      planSha: reviewedSha,
      openBlockers: Number(c.rows[0].open_blockers),
      openWarnings: Number(c.rows[0].open_warnings),
      path: plan.path,
    });
    // refs: the plan FILE, not the review id — validateRefs resolves only
    // decision/commit/session against REF_TABLE (board.ts:29), and plan_reviews
    // is deliberately not in it (§3.4).
    await beforeVerdictDeliveryForTests?.(pass);
    await postPlanNote(
      plan.id,
      body,
      [{ kind: 'file', path: plan.path }],
      { reviewPass: pass }
    );
  } catch (err) {
    warnings.push(
      `board-notify: could not post this verdict to the plan's board thread ` +
        `(${err instanceof Error ? err.message : String(err)}) — the review itself is safely recorded.`
    );
  }
}

async function planSummary(
  plan: PlanRow, passes: PassesMode = 'latest', reviewPass?: number,
): Promise<PlanSummary> {
  const c = await getPool().query<{ open_blockers: string; open_warnings: string; total: string }>(
    `SELECT
       count(*) FILTER (WHERE status = 'open' AND severity = 'blocker') AS open_blockers,
       count(*) FILTER (WHERE status = 'open' AND severity = 'warning') AS open_warnings,
       count(*) AS total
     FROM plan_findings WHERE plan_id = $1`,
    [plan.id]
  );
  // ONE plan_reviews statement per read (pass-1 B3): the row set and the total
  // share a snapshot. Two statements are two READ COMMITTED snapshots — a
  // review committed between them pairs a stale `latest` row with a newer
  // count, and the pointer calls the omitted NEWEST pass "earlier".
  // The total is computed in its own CTE so it survives a `none` scope and an
  // explicitly selected pass, where `picked` may return no row at all.
  const reviews = await getPool().query<Partial<ReviewHeader> & { review_count: string }>(
    `WITH total AS (SELECT count(*)::text review_count FROM plan_reviews WHERE plan_id=$1),
     picked AS (
      SELECT pass,kind,verdict,reviewer_agent,plan_sha,synthesis,created_at FROM plan_reviews
      WHERE plan_id=$1 AND ($2::int IS NULL OR pass=$2) AND $3::text<>'none'
      ORDER BY pass DESC
      LIMIT CASE WHEN $2::int IS NOT NULL OR $3='latest' THEN 1 ELSE 2147483647 END
     )
     SELECT p.*, total.review_count FROM total LEFT JOIN picked p ON true ORDER BY p.pass`,
    [plan.id, reviewPass ?? null, passes]
  );
  const review_count = Number(reviews.rows[0]?.review_count ?? 0);
  // The LEFT JOIN keeps the total row even when nothing was picked; that row
  // carries null review columns and is NOT a review.
  const picked: ReviewHeader[] = [];
  for (const { review_count: _rc, ...rv } of reviews.rows) {
    if (rv.pass === null || rv.pass === undefined) continue;
    picked.push({
      pass: rv.pass, kind: rv.kind ?? 'author', verdict: rv.verdict ?? 'blocked',
      reviewer_agent: rv.reviewer_agent ?? '', plan_sha: rv.plan_sha ?? null,
      synthesis: rv.synthesis ?? '', created_at: rv.created_at ?? '',
    });
  }
  if (reviewPass !== undefined && picked.length === 0) {
    throw new Error(`plan has no review pass ${reviewPass}`);
  }
  const r = c.rows[0];
  return {
    ...plan,
    findings: {
      open_blockers: Number(r.open_blockers),
      open_warnings: Number(r.open_warnings),
      total: Number(r.total),
    },
    review_count,
    reviews: picked,
  };
}

/** Resolve a plan reference (uuid or repo-relative path) to its row. */
export async function resolvePlan(ref: string): Promise<PlanRow> {
  const projectId = await getProjectId();
  const sql = UUID_RE.test(ref)
    ? `SELECT id, project_id, slug, path, title, current_sha, status
         FROM plans WHERE id = $1 AND project_id = $2`
    : `SELECT id, project_id, slug, path, title, current_sha, status
         FROM plans WHERE path = $1 AND project_id = $2`;
  const r = await getPool().query<PlanRow>(sql, [ref, projectId]);
  if (!r.rows[0]) {
    throw new Error(`No registered plan matches '${ref}'. Register it first with mai_plan.`);
  }
  return r.rows[0];
}

export interface ReviewPostArgs {
  plan: string; kind: ReviewKind; verdict: ReviewVerdict;
  /** REQUIRED (pass-4 B2): the analytical prose is the most valuable output of
   * a review (spec §7) — optional here meant it could be silently lost. */
  synthesis: string;
  findings: FindingInput[];
  /** MCP receipt guard. Direct internal callers may omit it; the public tool
   * requires it so a truncated/dropped findings array cannot commit cleanly. */
  finding_count?: number;
  /** The sha the reviewer pinned at review START (mai_plan's `sha`). R11. */
  plan_sha?: string;
}

export interface ReviewPostResult {
  review_id: string; pass: number; findings: Array<{ ref: string | null; id: string }>;
  /** Non-blocking integrity warnings: R-drift (plan mutated mid-review) and
   * R-location (a citation past the end of the file). Warn, never block (R11). */
  warnings: string[];
}

const SEVERITIES: FindingSeverity[] = ['blocker', 'warning', 'note'];
const REQUIRED_FINDING_FIELDS = ['title', 'location', 'issue', 'evidence', 'fix'] as const;

/** Runtime guard for enum-ish params (pass-4 W2): the MCP SDK enforces no
 * schema, so a typo'd filter would otherwise reach the query and return an
 * empty result that reads as "no findings" rather than "you typo'd the filter". */
function assertEnum(name: string, val: string | undefined, allowed: readonly string[]): void {
  if (val !== undefined && !allowed.includes(val)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')} — got '${val}'.`);
  }
}

/** Boundary validation for the nested findings array (pass-2 B4 / pass-3 B3):
 * the MCP SDK does not enforce inputSchema and validateRequiredParams checks
 * TOP-LEVEL params only, so a finding missing `evidence` would otherwise
 * surface as a raw PG not-null violation — the opaque-error class
 * validate-params.ts exists to eliminate, and the exact reason R3 makes the
 * columns NOT NULL. Same care findingUpdate applies to its note-less close. */
function validateFindings(findings: FindingInput[]): void {
  if (!Array.isArray(findings)) {
    throw new Error(`'findings' must be an array (empty is valid for a clean approval).`);
  }
  findings.forEach((f, i) => {
    const label = f?.ref ?? f?.title ?? `finding #${i + 1}`;
    for (const k of REQUIRED_FINDING_FIELDS) {
      if (typeof f?.[k] !== 'string' || !f[k].trim()) {
        throw new Error(
          `Finding '${label}': '${k}' is required and must be non-blank. evidence and fix are ` +
            `NOT optional — an empty field on a hurried write is a silent loss (R3).`
        );
      }
    }
    if (!SEVERITIES.includes(f.severity)) {
      throw new Error(
        `Finding '${label}': severity must be one of ${SEVERITIES.join(', ')} — got '${String(f.severity)}'.`
      );
    }
    if (f.recurrence_of !== undefined && !UUID_RE.test(f.recurrence_of)) {
      throw new Error(`Finding '${label}': recurrence_of must be a finding UUID, got '${f.recurrence_of}'.`);
    }
  });
}

/**
 * Post one review pass and all its findings atomically. `pass` is server-assigned
 * under UNIQUE(plan_id, pass); a genuine race raises 23505 and we retry once —
 * without the retry two concurrent blind reviewers would surface a raw PG error.
 *
 * Revision integrity (R11, spec §12): the stored plan_sha is the REVIEWER's pin,
 * not the plans-table row — the row's sha dates from the last register and can
 * be neither what the reviewer read nor what is on disk now. The spec §12
 * field failure #1 was a review whose line numbers silently decayed against a
 * plan that mutated mid-review; the pin-vs-file comparison surfaces that.
 */
export async function reviewPost(args: ReviewPostArgs): Promise<ReviewPostResult> {
  assertEnum('kind', args.kind, ['author', 'blind']);
  assertEnum('verdict', args.verdict, ['approved', 'blocked']);
  if (typeof args.synthesis !== 'string' || !args.synthesis.trim()) {
    throw new Error(
      `'synthesis' is required and must be non-blank — the analytical prose is the most valuable ` +
        `output of a review (spec §7), and a review posted without it is permanently just bookkeeping.`
    );
  }
  validateFindings(args.findings);
  if (args.finding_count !== undefined) {
    if (!Number.isSafeInteger(args.finding_count) || args.finding_count < 0) {
      throw new Error(`'finding_count' must be a non-negative integer.`);
    }
    if (args.finding_count !== args.findings.length) {
      throw new Error(
        `Review receipt mismatch: caller intended ${args.finding_count} finding(s), ` +
          `but the server received ${args.findings.length}. Nothing was posted.`
      );
    }
    const blockers = args.findings.filter((finding) => finding.severity === 'blocker').length;
    if (args.verdict === 'blocked' && blockers === 0) {
      throw new Error(`A blocked review must include at least one blocker finding. Nothing was posted.`);
    }
    if (args.verdict === 'approved' && blockers > 0) {
      throw new Error(`An approved review cannot include blocker findings. Nothing was posted.`);
    }
  }
  const plan = await resolvePlan(args.plan);
  const abs = await resolvePlanPath(plan.project_id, plan.path);

  // Pre-embed FIRST, before any integrity read (pass-2 W5 + pass-6 B3
  // ordering): a cold local model costs up to LOCAL_INIT_TIMEOUT_MS (20s), and
  // hashing BEFORE that window meant a plan edited mid-embedding recorded the
  // pre-edit sha — no drift warning, and plans.current_sha refreshed with
  // stale data. Embedding outside the transaction also keeps BEGIN clear of
  // idle_in_transaction_session_timeout (120s pool default) — losing a posted
  // review is spec §12 failure #4, the thing this plan exists to prevent —
  // and a 23505 retry re-uses the vectors. Stored passages use RAW embed():
  // embedQuery()'s instruction prefix is retrieval-only (plan 14).
  const { embed } = await import('./embeddings.js');
  const vecs: Array<number[] | null> = [];
  for (const f of args.findings) {
    vecs.push(await embed(`${f.title}. ${f.issue}`));
  }

  // ONE read serves BOTH integrity checks (pass-6 B3): sha and line count must
  // describe the same bytes — deriving them from two reads is a TOCTOU window
  // where citations validate against text the hash never saw.
  const buf = await fs.readFile(abs).catch(() => {
    throw new Error(`Cannot read plan file at '${plan.path}' (resolved: ${abs}).`);
  });
  const fileSha = crypto.createHash('sha256').update(buf).digest('hex');
  const warnings: string[] = [];
  if (args.plan_sha && args.plan_sha !== fileSha) {
    warnings.push(
      `R-drift: plan mutated mid-review (pinned ${args.plan_sha.slice(0, 8)}… ≠ current ` +
        `${fileSha.slice(0, 8)}…) — file:line citations may have decayed; re-check locations.`
    );
  } else {
    // R-location — only for citations into THE PLAN ITSELF (registered path or
    // bare filename). A source-file citation (src/x.ts:588) is validated
    // against nothing: the server holds no pinned copy of that file, and
    // warning on it was pass-2 B5's false-positive class. Also only when the
    // text on disk IS the text reviewed (pin matches, or no pin was given so
    // the current file is the best truth).
    const lineCount = buf.toString('utf8').split('\n').length;
    const base = path.basename(plan.path);
    for (const f of args.findings) {
      // Both range endpoints are validated (pass-4 B6): capturing only the
      // start let `plan.md:10-999999` pass as line 10.
      const m = /^(.*?):(\d+)(?:[-–](\d+))?$/.exec(f.location);
      if (!m) continue;
      const cited = m[1];
      if (cited !== plan.path && cited !== base) continue;
      const start = Number(m[2]);
      const end = m[3] === undefined ? start : Number(m[3]);
      if (start > lineCount || end > lineCount) {
        warnings.push(
          `R-location: '${f.ref ?? f.title}' cites ${f.location} but the plan has ${lineCount} lines.`
        );
      } else if (end < start) {
        warnings.push(
          `R-location: '${f.ref ?? f.title}' cites ${f.location} — reversed range (end before start).`
        );
      }
    }
  }
  const reviewedSha = args.plan_sha ?? fileSha;
  let result: ReviewPostResult | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await reviewPostOnce(plan, args, vecs, reviewedSha, fileSha, warnings);
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505' && attempt === 0) continue; // pass collision — retry
      throw err;
    }
  }
  if (!result) throw new Error('Could not assign a review pass number after a retry.');
  // Bridge A fires here — OUTSIDE the transaction, and exactly once per
  // successfully committed review (the 23505 retry wraps reviewPostOnce only).
  await notifyVerdict(plan, args, result.pass, reviewedSha, warnings);
  return result;
}

async function reviewPostOnce(
  plan: PlanRow,
  args: ReviewPostArgs,
  vecs: Array<number[] | null>,
  reviewedSha: string,
  fileSha: string,
  warnings: string[]
): Promise<ReviewPostResult> {
  const { currentEmbeddingModelId } = await import('./embeddings.js');
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The aggregate is LOAD-BEARING (review W1): MAX() over an empty set still
    // returns one row (NULL), so COALESCE gives pass 1 for a plan's first
    // review. Adding a GROUP BY or dropping the aggregate would make the very
    // first INSERT match zero rows and silently insert nothing.
    const review = await client.query<{ id: string; pass: number }>(
      `INSERT INTO plan_reviews
         (plan_id, pass, kind, reviewer_agent, reviewer_session, verdict, plan_sha, synthesis)
       SELECT $1,
              COALESCE(MAX(pass), 0) + 1,
              $2, $3, $4, $5, $6, $7
         FROM plan_reviews WHERE plan_id = $1
       RETURNING id, pass`,
      [
        plan.id, args.kind,
        agentIdentity(),
        INSTANCE_SESSION,
        args.verdict, reviewedSha, args.synthesis,
      ]
    );
    const reviewId = review.rows[0].id;
    const out: Array<{ ref: string | null; id: string }> = [];

    for (const [i, f] of args.findings.entries()) {
      const vec = vecs[i] ?? null; // pre-embedded in reviewPost, outside the txn
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO plan_findings
           (review_id, plan_id, project_id, ref, severity, title, location,
            issue, evidence, fix, embedding, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          reviewId, plan.id, plan.project_id, f.ref ?? null, f.severity, f.title,
          f.location, f.issue, f.evidence, f.fix,
          vec, vec ? currentEmbeddingModelId() : null,
        ]
      );
      const id = inserted.rows[0].id;
      out.push({ ref: f.ref ?? null, id });

      // Spec §2.3 / decision ba95ae4a: the finding and its load-bearing refs
      // share this review transaction. Deliberately before recurrence_of so a
      // later invalid edge proves the citation + counter roll back too.
      await recordFindingReferences(client, plan.project_id, id, f.issue, f.evidence);

      if (f.recurrence_of) {
        // UUID syntax was checked at the boundary (validateFindings); the
        // TARGET must also exist in the pinned project (pass-3 B3):
        // memory_edges has no FK on from_id/to_id, so a typo'd or
        // cross-project UUID would otherwise land as a dangling edge nothing
        // can ever render. src/edges.ts applies the same ownership check.
        const target = await client.query(
          `SELECT 1 FROM plan_findings WHERE id = $1 AND project_id = $2`,
          [f.recurrence_of, plan.project_id]
        );
        if (target.rowCount === 0) {
          const code = await client.query(
            `SELECT 1 FROM code_findings WHERE id = $1 AND project_id = $2`,
            [f.recurrence_of, plan.project_id]
          );
          if (code.rowCount) {
            throw new Error(
              `Finding '${f.ref ?? f.title}': recurrence_of ${f.recurrence_of} is a CODE finding — ` +
              `plan-review findings recur from earlier plan-review findings only. Drop the recurrence_of ` +
              `and cite the code finding's UUID in evidence instead.`
            );
          }
          throw new Error(
            `Finding '${f.ref ?? f.title}': recurrence_of ${f.recurrence_of} matches no finding in this project.`
          );
        }
        await client.query(
          `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation, note)
           VALUES ($1,'finding',$2,'finding',$3,'recurrence_of',$4)
           ON CONFLICT (from_kind, from_id, to_kind, to_id, relation) DO NOTHING`,
          [plan.project_id, id, f.recurrence_of, `pass ${review.rows[0].pass}`]
        );
      }
    }
    // R11: keep the identity row fresh in the same transaction — plans.current_sha
    // now reflects the file as of this post, while the review row keeps the
    // reviewer's pin. Two different questions, two different columns.
    await client.query(`UPDATE plans SET current_sha = $2, updated_at = now() WHERE id = $1`, [
      plan.id, fileSha,
    ]);
    await client.query('COMMIT');
    return { review_id: reviewId, pass: review.rows[0].pass, findings: out, warnings };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface FindingsQueryArgs {
  plan?: string; status?: FindingStatus; severity?: FindingSeverity;
  similar_to?: string; limit?: number;
  /** One finding as `UUID` (part 1) or `UUID:part` — exclusive with every
   * other filter. The bounded complete-recovery path for an oversized body. */
  finding?: string;
  /** Present only on the MCP path; direct/CLI callers omit it and get the
   * same complete string as before (plan 23 R8). */
  budget?: ReadBudget;
  shadow?: (draft: MaiShadowDraft) => void;
}

/** Both finding tables project into ONE row shape so the two halves cannot
 * diverge (plan 24 R5). `kind` is selected as a literal, so every consumer —
 * markdown renderer, JSON payload, recurrence recall — can label the source
 * without a second query. code_findings has no `ref` semantics tied to a review
 * pass, so its `ref` rides through unchanged.
 *
 * UNION ALL, never UNION: the two tables mint independent gen_random_uuid()
 * values, so a duplicate id is unreachable and there is nothing to dedupe.
 * UNION would buy a sort on every findings read and remove nothing (R5). */
const FINDING_UNION_COLUMNS = `
  id, plan_id, ref, severity, title, location, issue, evidence, fix,
  status, resolution_note, created_at`;

const PLAN_FINDING_SELECT = `SELECT 'plan'::text AS kind, ${FINDING_UNION_COLUMNS} FROM plan_findings`;
const CODE_FINDING_SELECT = `SELECT 'code'::text AS kind, ${FINDING_UNION_COLUMNS} FROM code_findings`;

/** The semantic site (:1065) SELECTs `embedding` as well and hands it straight
 * to cosineSim — projecting the twelve-column shape there would delete the
 * column the very next statement reads (pass-1 B2). A second pair, not an
 * `embedding` bolted onto the shared one: every other site would then carry a
 * vector it never reads across the wire. */
const PLAN_FINDING_SELECT_VEC =
  `SELECT 'plan'::text AS kind, ${FINDING_UNION_COLUMNS}, embedding FROM plan_findings`;
const CODE_FINDING_SELECT_VEC =
  `SELECT 'code'::text AS kind, ${FINDING_UNION_COLUMNS}, embedding FROM code_findings`;

/**
 * Read findings. Without `similar_to` this is the handoff read (one plan's
 * findings by status). With `similar_to` it is project-wide recall — "has
 * something like this been found before?" — following plan 14's closed state
 * model exactly: no provider or no query vector → trigram over all eligible
 * rows; provider available → current-tag cosine PLUS a separate trigram pass
 * over stale/untagged rows, merged under one budget. `plan`/`status`/`severity`
 * compose with BOTH modes.
 */
export async function findingsQuery(args: FindingsQueryArgs): Promise<string> {
  assertEnum('status', args.status, FINDING_STATUSES);
  assertEnum('severity', args.severity, SEVERITIES);
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error(`limit must be a positive integer, got: ${JSON.stringify(args.limit)}`);
  }
  const pool = getPool();
  const projectId = await getProjectId();
  const limit = args.limit ?? 15;

  // R6: the bounded single-finding selector. It is not a filter that composes —
  // it names exactly one row, so anything that would narrow a SET is rejected
  // rather than silently ignored.
  if (args.finding !== undefined) {
    const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([1-9]\d*))?$/i
      .exec(args.finding);
    if (!m) {
      throw new Error(
        `finding must be "UUID" or "UUID:part" with a positive integer part, got: ${JSON.stringify(args.finding)}`
      );
    }
    if (args.plan !== undefined || args.status !== undefined || args.severity !== undefined
      || args.similar_to !== undefined || args.limit !== undefined) {
      throw new Error(
        'finding is exclusive with plan, status, severity, similar_to and limit — it selects exactly one finding'
      );
    }
    const findingId = m[1];
    const part = m[2] === undefined ? 1 : Number(m[2]);
    const one = await pool.query<FindingRow>(
      `SELECT * FROM (
         ${PLAN_FINDING_SELECT} WHERE project_id = $1 AND id = $2
         UNION ALL
         ${CODE_FINDING_SELECT} WHERE project_id = $1 AND id = $2
       ) f`,
      [projectId, findingId]
    );
    if (one.rows.length === 0) throw new Error(`no finding \`${findingId}\` in this project`);
    // The UNCHANGED complete-body renderer produces the page body, so the
    // concatenated parts reproduce the normal render byte-for-byte.
    const complete = await formatFindingSections([{ heading: 'Findings', rows: one.rows }]);
    if (args.budget === undefined) {
      // A direct/unbudgeted call never silently becomes budgeted: there is
      // exactly one part, so a later part is an honest out-of-range error.
      if (part > 1) throw new Error(`Finding part ${part} exceeds 1`);
      return complete;
    }
    return budgetPage(
      pageBudget(), `finding ${findingId}`, complete, part, 'finding',
      (n) => `call mai_findings with finding:"${findingId}:${n}"`,
    ).text;
  }

  // The three filters compose with BOTH modes (pass-8 W1: they were validated
  // then silently dropped on the similar_to path — the stronger variant of
  // pass-4 W2's typo'd-enum defect). All three stay optional with NO defaults:
  // Phase-1.0 recall must keep seeing resolved findings, or recurrence
  // detection goes blind.
  const planId = args.plan ? (await resolvePlan(args.plan)).id : null;
  const status = args.status ?? null;
  const severity = args.severity ?? null;

  if (!args.similar_to) {
    const conds = ['project_id = $1'];
    const params: unknown[] = [projectId];
    if (planId) { conds.push(`plan_id = $${params.length + 1}`); params.push(planId); }
    if (status) { conds.push(`status = $${params.length + 1}`); params.push(status); }
    if (severity) { conds.push(`severity = $${params.length + 1}`); params.push(severity); }
    params.push(limit);
    const r = await pool.query<FindingRow>(
      `SELECT * FROM (
         ${PLAN_FINDING_SELECT} WHERE ${conds.join(' AND ')}
         UNION ALL
         ${CODE_FINDING_SELECT} WHERE ${conds.join(' AND ')}
       ) f
        ORDER BY (severity = 'blocker') DESC, created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return await formatFindings(r.rows, 'Findings', args.budget, args.shadow);
  }

  const { embedQuery, embeddingsEnabled, cosineSim, currentEmbeddingModelId, budgetHybridHits } =
    await import('./embeddings.js');
  const modelId = embeddingsEnabled() ? currentEmbeddingModelId() : null;
  const queryVec = modelId ? await embedQuery(args.similar_to) : null;

  // Optional-filter predicate trio below follows the trgmDecisionHits
  // `$n IS NULL OR` idiom (decisions.ts:893) in all four queries.
  if (!modelId || !queryVec) {
    const r = await pool.query<FindingRow>(
      `SELECT * FROM (
         ${PLAN_FINDING_SELECT}
          WHERE project_id = $1 AND similarity(title, $2) >= 0.15
            AND ($4::uuid IS NULL OR plan_id = $4)
            AND ($5::text IS NULL OR status = $5)
            AND ($6::text IS NULL OR severity = $6)
         UNION ALL
         ${CODE_FINDING_SELECT}
          WHERE project_id = $1 AND similarity(title, $2) >= 0.15
            AND ($4::uuid IS NULL OR plan_id = $4)
            AND ($5::text IS NULL OR status = $5)
            AND ($6::text IS NULL OR severity = $6)
       ) f
        ORDER BY similarity(title, $2) DESC
        LIMIT $3`,
      [projectId, args.similar_to, limit, planId, status, severity]
    );
    return await formatFindings(r.rows, 'Similar past findings (text match)', args.budget, args.shadow);
  }

  const current = await pool.query<FindingRow & { embedding: number[] }>(
    `SELECT * FROM (
       ${PLAN_FINDING_SELECT_VEC}
        WHERE project_id = $1 AND embedding IS NOT NULL AND embedding_model = $2
          AND ($3::uuid IS NULL OR plan_id = $3)
          AND ($4::text IS NULL OR status = $4)
          AND ($5::text IS NULL OR severity = $5)
       UNION ALL
       ${CODE_FINDING_SELECT_VEC}
        WHERE project_id = $1 AND embedding IS NOT NULL AND embedding_model = $2
          AND ($3::uuid IS NULL OR plan_id = $3)
          AND ($4::text IS NULL OR status = $4)
          AND ($5::text IS NULL OR severity = $5)
     ) f`,
    [projectId, modelId, planId, status, severity]
  );
  const scored = current.rows
    .map((f) => ({ f, sim: cosineSim(queryVec, f.embedding) }))
    .filter((s) => s.sim >= 0.25)
    .sort((a, b) => b.sim - a.sim)
    .map((s) => s.f);

  // Third state (plan 14 R4, restored by pass-5 B1, corrected by pass-7 B1):
  // zero semantic hits → trigram over ALL eligible rows, exactly as
  // decisionsSimilarOrTrgm does — its below-threshold attempt returns
  // 'unavailable' and falls through to trgmDecisionHits(…, staleForModel: null),
  // an all-row pass that fires BEFORE the stale bucket is ever queried
  // (decisions.ts:915-918, :893). The stale bucket is therefore queried only
  // when semantic hits exist — a stale text hit must never suppress the rescue
  // of a lexically matching current-model row that cosine rejected. The
  // stricter "cosine-rejected is never trigram-re-accepted" rule is plan 14
  // R5's DEDUP matrix — a safety rule for writes that reinforce, deliberately
  // NOT the search model. Search rescues; dedup refuses.
  if (scored.length === 0) {
    const all = await pool.query<FindingRow>(
      `SELECT * FROM (
         ${PLAN_FINDING_SELECT}
          WHERE project_id = $1 AND similarity(title, $2) >= 0.15
            AND ($4::uuid IS NULL OR plan_id = $4)
            AND ($5::text IS NULL OR status = $5)
            AND ($6::text IS NULL OR severity = $6)
         UNION ALL
         ${CODE_FINDING_SELECT}
          WHERE project_id = $1 AND similarity(title, $2) >= 0.15
            AND ($4::uuid IS NULL OR plan_id = $4)
            AND ($5::text IS NULL OR status = $5)
            AND ($6::text IS NULL OR severity = $6)
       ) f
        ORDER BY similarity(title, $2) DESC
        LIMIT $3`,
      [projectId, args.similar_to, limit, planId, status, severity]
    );
    return await formatFindings(all.rows, 'Similar past findings (text match)', args.budget, args.shadow);
  }

  const stale = await pool.query<FindingRow>(
    `SELECT * FROM (
       ${PLAN_FINDING_SELECT}
        WHERE project_id = $1 AND embedding_model IS DISTINCT FROM $2
          AND similarity(title, $3) >= 0.15
          AND ($5::uuid IS NULL OR plan_id = $5)
          AND ($6::text IS NULL OR status = $6)
          AND ($7::text IS NULL OR severity = $7)
       UNION ALL
       ${CODE_FINDING_SELECT}
        WHERE project_id = $1 AND embedding_model IS DISTINCT FROM $2
          AND similarity(title, $3) >= 0.15
          AND ($5::uuid IS NULL OR plan_id = $5)
          AND ($6::text IS NULL OR status = $6)
          AND ($7::text IS NULL OR severity = $7)
     ) f
      ORDER BY similarity(title, $3) DESC
      LIMIT $4`,
    [projectId, modelId, args.similar_to, limit, planId, status, severity]
  );

  const sel = budgetHybridHits(scored, stale.rows, limit);
  // Both buckets are preserved as SECTIONS and budgeted once after selection —
  // never independently, or two subsections could each look small while the
  // combined result blew the cap (plan 23, Task 4 aggregate rule).
  return await formatFindingSections([
    { heading: 'Similar past findings', rows: sel.semantic },
    { heading: 'Also matched by text — not yet re-embedded (`mai embed --rebuild`)', rows: sel.stale },
  ], args.budget, args.shadow);
}

/** Recovery route named on every shortened findings response (plan 23 R9): the
 * single-finding selector FIRST — it is the only one that returns a complete
 * oversized body — then the filters that narrow a broad row set. */
const FINDINGS_NARROWING =
  'use finding:"UUID[:part]" for one complete finding, or filter by severity/status/plan or lower limit';

/** One recurrence read for the WHOLE union (plan 23): the hybrid path renders
 * two sections but must not issue two edge queries or make two row decisions. */
async function findingRecurrence(rows: readonly FindingRow[]): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  // Recurrence is READ here (pass-2 W7): the edge is written by mai_review_post
  // and mai_edges' EdgeKind enum cannot reach 'finding' — if this read did not
  // render it, the Goal's "linkable by recurrence" would be write-only data.
  const links = await getPool().query<{ from_id: string; to_id: string }>(
    `SELECT from_id, to_id FROM memory_edges
      WHERE relation = 'recurrence_of' AND from_kind = 'finding'
        AND from_id = ANY($1::uuid[])`,
    [rows.map((f) => f.id)]
  );
  return new Map(links.rows.map((e) => [e.from_id, e.to_id]));
}

/** The complete row, verbatim from the pre-plan-23 loop.
 * evidence and resolution_note RENDER (pass-4 B1): both are selected by
 * every query feeding this formatter, and R3 makes evidence mandatory
 * precisely so the reviewer's reasoning survives the handoff — dropping
 * them at format time made the NOT NULL constraint theater. */
function findingFullRow(f: FindingRow, recur: Map<string, string>): string {
  const lines = [
    `- \`${f.id}\` [${f.kind === 'code' ? 'code/' : ''}${f.severity}/${f.status}]${f.ref ? ` (${f.ref})` : ''} **${f.title}**`,
    `  where: ${f.location}`,
    `  issue: ${f.issue}`,
    `  evidence: ${f.evidence}`,
    `  fix: ${f.fix}`,
  ];
  if (f.resolution_note) lines.push(`  resolved: ${f.resolution_note}`);
  const to = recur.get(f.id);
  if (to) lines.push(`  recurs: earlier finding \`${to}\``);
  return lines.join('\n');
}

/** The headline row: identity, enums and recurrence are never truncated; only
 * the two free-text fields are one-lined and field-capped. */
function findingHeadlineRow(f: FindingRow, recur: Map<string, string>): string {
  const to = recur.get(f.id);
  return `- \`${f.id}\` [${f.kind === 'code' ? 'code/' : ''}${f.severity}/${f.status}]${f.ref ? ` (${f.ref})` : ''} ` +
    `**${headlineField(f.title)}** · ${headlineField(f.location, 320)}` +
    `${to ? ` · recurs \`${to}\`` : ''}`;
}

export interface FindingSection { heading: string; rows: readonly FindingRow[] }

/** ONE global row decision across every section (plan 23): the union's row
 * count and exact complete-render length decide the shape, section labels
 * appear only on their first retained row, and one shown/total pointer covers
 * the whole result. The leading newline on later headings reproduces the
 * pre-plan-23 `parts.join('\n\n')` byte-for-byte on unbudgeted calls. */
async function formatFindingSections(
  sections: readonly FindingSection[], budget?: ReadBudget,
  shadow?: (draft: MaiShadowDraft) => void,
): Promise<string> {
  const populated = sections.filter((s) => s.rows.length > 0);
  const union = populated.flatMap((s) => s.rows);
  if (union.length === 0) return 'No findings match.';
  const recur = await findingRecurrence(union);
  const readSections: ReadSection[] = populated.map((s, i) => ({
    heading: `${i === 0 ? '' : '\n'}# ${s.heading}\n`,
    fullRows: s.rows.map((f) => findingFullRow(f, recur)),
    headlineRows: s.rows.map((f) => findingHeadlineRow(f, recur)),
  }));
  const baseline = budgetSections(budget, readSections, 'finding', FINDINGS_NARROWING);
  if (shadow && budget) {
    try {
      const candidate = budgetSections(
        { fullRows: 0, charBudget: MAI_SHADOW_CHAR_CAP }, readSections, 'finding', FINDINGS_NARROWING,
      );
      const identities: FindingShadowIdentity[] = populated.flatMap((section) => section.rows.map((row) => ({
        id: row.id, status: row.status, severity: row.severity,
        title: row.title, location: row.location,
      })));
      shadow(findingCandidate(readSections, identities, baseline, candidate));
    } catch { shadow({ kind: 'skip', reason: 'missing-field' }); }
  }
  return baseline;
}

async function formatFindings(
  rows: FindingRow[], heading: string, budget?: ReadBudget,
  shadow?: (draft: MaiShadowDraft) => void,
): Promise<string> {
  return formatFindingSections([{ heading, rows }], budget, shadow);
}

export interface FindingUpdateArgs {
  finding_id: string;
  /** Omit to leave status untouched (a location-only repair). */
  status?: FindingStatus;
  note?: string;
  /** Corrected `file:line` citation (pass-3 B4: the plan-review skill tells a
   * reviewer to repair a decayed location — this is the field that makes that
   * instruction executable). */
  location?: string;
}

/** Transition a finding's status and/or repair its location. The executor is
 * the only actor that knows whether a fix actually landed, which is what makes
 * `status` real. */
export async function findingUpdate(args: FindingUpdateArgs): Promise<string> {
  if (!UUID_RE.test(args.finding_id)) {
    throw new Error(`finding_id must be a UUID, got '${args.finding_id}'.`);
  }
  assertEnum('status', args.status, FINDING_STATUSES);
  if (args.status === undefined && args.location === undefined) {
    throw new Error(`Nothing to update — pass 'status', 'location', or both.`);
  }
  if (args.status !== undefined && args.status !== 'open' && !args.note?.trim()) {
    // Caught here so the agent gets a self-correcting message rather than a
    // raw PG check violation from plan_findings_closed_needs_note.
    throw new Error(`Closing a finding as '${args.status}' requires a note saying why.`);
  }
  const projectId = await getProjectId();
  const client = await getPool().connect();
  let row: {
    id: string; title: string; status: string; plan_id: string;
    review_sha: string | null; issue: string; evidence: string;
  } | undefined;
  try {
    await client.query('BEGIN');
    const r = await client.query<{
      id: string; title: string; status: string; plan_id: string;
      review_sha: string | null; issue: string; evidence: string;
    }>(
      `UPDATE plan_findings f
          SET status = COALESCE($2, f.status),
              location = COALESCE($6, f.location),
              resolution_note = CASE WHEN $2 IS NULL THEN f.resolution_note ELSE $3 END,
              resolved_at = CASE WHEN $2 IS NULL THEN f.resolved_at
                                 WHEN $2 = 'open' THEN NULL ELSE now() END,
              resolved_by_agent = CASE WHEN $2 IS NULL THEN f.resolved_by_agent
                                       WHEN $2 = 'open' THEN NULL ELSE $4 END
        FROM plan_reviews rv
        WHERE f.id = $1 AND f.project_id = $5 AND rv.id = f.review_id
        RETURNING f.id, f.title, f.status, f.plan_id, rv.plan_sha AS review_sha,
                  f.issue, f.evidence`,
      [args.finding_id, args.status ?? null, args.note?.trim() ?? null, agentIdentity(),
       projectId, args.location ?? null]
    );
    row = r.rows[0];
    if (!row) {
      const code = await client.query(
        `SELECT 1 FROM code_findings WHERE id = $1 AND project_id = $2`,
        [args.finding_id, projectId]
      );
      if (code.rowCount) {
        throw new Error(
          `Finding ${args.finding_id} is a CODE finding — close it from the CLI: ` +
          `mai code-findings close ${args.finding_id} --status <fixed|disputed|accepted-risk> ` +
          `--note "..." --project <slug>`
        );
      }
      throw new Error(`No finding ${args.finding_id} in this project.`);
    }
    // Re-scan stored immutable issue/evidence: this backfills a pre-plan
    // finding when touched. The partial unique index makes repeats no-ops and
    // recordFindingReferences bumps only on a returned INSERT.
    await recordFindingReferences(client, projectId, row.id, row.issue, row.evidence);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // Assigned on every successful path; the guard keeps both TS and future
  // control-flow edits honest without an assertion cast.
  if (!row) throw new Error(`No finding ${args.finding_id} in this project.`);
  let out = `Finding ${row.id.slice(0, 8)} → ${row.status}: "${row.title}"`;
  // Close-time drift check (R11, spec §12): when a finding is being CLOSED,
  // re-hash the plan and warn if it no longer matches the sha the finding's
  // review pinned — the closer may be marking "fixed" against text the finding
  // never described. Warn, never block (§3); hash failure (file moved/deleted)
  // degrades to silence rather than blocking the close.
  if (args.status !== undefined && args.status !== 'open' && row.review_sha) {
    try {
      const plan = await getPool().query<{ path: string; project_id: string }>(
        `SELECT path, project_id FROM plans WHERE id = $1`, [row.plan_id]
      );
      if (plan.rows[0]) {
        const abs = await resolvePlanPath(plan.rows[0].project_id, plan.rows[0].path);
        const nowSha = await shaOfFile(abs, plan.rows[0].path);
        if (nowSha !== row.review_sha) {
          out += `\n⚠ R-drift: the plan has changed since this finding's review pinned ` +
            `${row.review_sha.slice(0, 8)}… — its citations may describe older text; re-check before trusting them.`;
        }
      }
    } catch (e) {
      // Best-effort must still SPEAK (pass-4 W3): the close lands either way,
      // but a silent verification failure is indistinguishable from a
      // verified clean close — the operator loses the only integrity signal.
      out += `\n⚠ R-drift: could not verify the plan against this finding's review pin ` +
        `(${e instanceof Error ? e.message : String(e)}) — treat its citations as unverified.`;
    }
  }
  return out;
}

/**
 * Public mai_plan boundary: coerces raw tool params, registers/fetches, and
 * renders the summary text — including the earlier-pass pointer (plan 17 R2).
 * Lives HERE, not in index.ts, so the boundary is testable (pass-1 B2) and
 * matches the house pattern (findingsQuery returns formatted text).
 */
export async function planText(
  params: Record<string, unknown>, budget?: ReadBudget,
  shadow?: (draft: MaiShadowDraft) => void,
): Promise<string> {
  // THE single validator for both history selectors (plan 23): index.ts hands
  // raw params straight through, so every rejection has to be named here.
  const isWrite = params.status !== undefined;
  const passRaw = params.pass === undefined ? undefined : String(params.pass);
  if (passRaw !== undefined && params.passes !== undefined) {
    throw new Error('pass is exclusive with passes — select one review pass or a passes scope, not both');
  }
  let reviewPass: number | undefined;
  let reviewPart = 1;
  if (passRaw !== undefined) {
    const m = /^([1-9]\d*)(?::([1-9]\d*))?$/.exec(passRaw);
    if (!m) {
      throw new Error(`pass must be "N" or "N:part" with positive integers, got '${passRaw}'`);
    }
    reviewPass = Number(m[1]);
    reviewPart = m[2] === undefined ? 1 : Number(m[2]);
  }
  const p = await planRegister({
    path: String(params.path),
    slug: params.slug === undefined ? undefined : String(params.slug),
    title: params.title === undefined ? undefined : String(params.title),
    status: params.status as PlanStatus | undefined,
    passes: params.passes as Exclude<PassesMode, 'none'> | undefined,
    reviewPass: isWrite ? undefined : reviewPass,
  });
  const header =
    `plan \`${p.id}\` [${p.status}] ${p.slug}\n  path: ${p.path}\n  sha: ${p.current_sha}\n` +
    `  findings: ${p.findings.open_blockers} open blocker(s), ${p.findings.open_warnings} open warning(s), ${p.findings.total} total`;

  // R5: a status write is metadata + counts + pointers, never a synthesis dump,
  // whichever history selector rode along.
  if (isWrite) {
    const posted = p.review_count > 0
      ? `\n  (${p.review_count} pass(es) posted — call with pass:"N" for one complete review)`
      : "";
    const tasks = p.operator_tasks === undefined ? ''
      : `\noperator tasks for ${p.title ?? p.slug}`
        + `${p.current_sha ? ` @ ${p.current_sha.slice(0, 8)}` : ''}: `
        + `${p.operator_tasks.inserted} inserted, ${p.operator_tasks.existing} existing; `
        + `${p.operator_tasks.blocking} blocking, ${p.operator_tasks.follow_up} follow-up — `
        + `My Tasks: ${p.operator_tasks.url}`;
    return budgetText(budget, header + posted + tasks, 'call mai_plan with pass:"N" for one complete review');
  }

  // R6: one explicitly selected pass, retrievable complete across bounded parts.
  // Concatenating the framed body parts reproduces the synthesis byte-for-byte.
  if (reviewPass !== undefined) {
    const rv = p.reviews[0];
    if (!rv) throw new Error(`plan has no review pass ${reviewPass}`);
    const meta = `${header}\n  pass ${rv.pass} [${rv.kind}/${rv.verdict}] by ${rv.reviewer_agent}` +
      `${rv.plan_sha ? ` @ ${rv.plan_sha.slice(0, 8)}` : ""}`;
    if (budget === undefined) {
      // Unbudgeted callers get the one complete render; there is exactly one
      // part, so a later part is an honest out-of-range error, never silence.
      if (reviewPart > 1) throw new Error(`Review synthesis part ${reviewPart} exceeds 1`);
      return `${meta}${rv.synthesis ? `\n      ${rv.synthesis.replace(/\n/g, "\n      ")}` : ""}`;
    }
    return budgetPage(
      pageBudget(), meta, rv.synthesis, reviewPart, 'synthesis',
      (n) => `call mai_plan with pass:"${reviewPass}:${n}"`,
    ).text;
  }

  // Reviews render WITH their synthesis (R1: readable back — a clean
  // zero-finding approval must be visible here, and the synthesis is the
  // most valuable part of a review, not metadata to truncate away).
  const reviews = p.reviews.length === 0
    ? ""
    : "\n  reviews:\n" + p.reviews.map((rv) =>
        `    pass ${rv.pass} [${rv.kind}/${rv.verdict}] by ${rv.reviewer_agent}` +
        `${rv.plan_sha ? ` @ ${rv.plan_sha.slice(0, 8)}` : ""}` +
        `${rv.synthesis ? `\n      ${rv.synthesis.replace(/\n/g, "\n      ")}` : ""}`
      ).join("\n");
  // Discoverability lives here, not in schema prose (plan 17 R2): when the
  // latest scope omits passes, say how many and how to get them.
  const omitted = p.review_count - p.reviews.length;
  const pointer = omitted > 0
    ? `\n  (${omitted} earlier pass(es) — call with pass:"N" for one complete review, or passes:"all")`
    : "";
  const selected = p.reviews[0];
  const narrowing = params.passes === 'all'
    ? 'call mai_plan with pass:"N" for one visible pass'
    : selected
      ? `call mai_plan with pass:"${selected.pass}"`
      : 'call mai_plan with pass:"N" for one complete review';
  const baseline = budgetText(budget, header + reviews + pointer, narrowing);
  if (shadow && budget) {
    try {
      shadow(planCandidate(header, p.reviews.map((rv) => ({
        pass: rv.pass, verdict: rv.verdict, reviewer: rv.reviewer_agent,
        planSha: rv.plan_sha, synthesis: rv.synthesis,
      })), baseline, pointer));
    } catch { shadow({ kind: 'skip', reason: 'missing-field' }); }
  }
  return baseline;
}
