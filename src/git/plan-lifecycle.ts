// Plan lifecycle auto-advance (plan 21, spec 2026-08-12 §4). A DERIVATION pass
// over git evidence, run after commits and files are in the DB — the same hook
// point and the same established pattern as autoLinkDecisions (src/git/sync.ts:101),
// reached in production through sync-commits, which both harnesses already run
// (hooks/session-end-ingest.sh:27, hooks/codex-notify-ingest.sh:58).
//
// The ONLY state this mutates is plans.status: one direction, from ONE legal
// predecessor, behind MAI_PLAN_AUTOADVANCE. `executed` is SUGGEST-never-auto —
// a completion claim requires evidence, and nothing here is evidence.
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { PlanThreadRef } from '../coordination-api.js';
import { getPool, loadProjectGraphRoots } from '../db.js';
import { planAutoAdvanceMode, type PlanAutoAdvance } from '../env.js';
import {
  capNoteBody, postPlanNote, retractPlanNote, type PlanStatus,
} from '../plans.js';
import { budgetRows, headlineField } from '../read-budget.js';

/** Correctness is not presentation: every live candidate is evaluated, while
 * only the prime rendering is capped (plan 21 ambiguity 8). */
const SECTION_TOP_N = 3;
const LIFECYCLE_NARROWING = 'use mai_plan for plan status and review history';

interface CandidateRow {
  id: string;
  slug: string;
  path: string;
  status: PlanStatus;
  /** COALESCE(max approved-review time, plans.created_at) — spec §4.3. */
  anchor: string;
  open_findings: string;
}

interface CommitHit {
  id: string;
  at: number;
}

interface RepoPrefix {
  repo: string;
  aliases: readonly string[];
  /** null means this repo is not proven inside the project's umbrella. */
  prefix: string | null;
}

type Action = 'flip' | 'suggest-executing' | 'suggest-executed' | 'retract';

interface Evaluation {
  plan: CandidateRow;
  commits: CommitHit[];
  action: Action;
}

type Queryable = Pool | PoolClient;

/** `plan-19-codex-cli-provider` → `19`; null when the slug carries no number. */
export function planNumberToken(slug: string): string | null {
  const m = /(?:^|-)plan-(\d+)(?:-|$)/.exec(slug);
  return m ? m[1] : null;
}

export function formatExecutingNote(a: { slug: string; commits: number; path: string }): string {
  return capNoteBody(
    `${a.slug} — approved → executing: ${a.commits} task commit(s) since approval. ` +
      `Read: mai_plan {path:"${a.path}"}`
  );
}

export function formatExecutingSuggestion(a: { slug: string; commits: number; path: string }): string {
  return capNoteBody(
    `${a.slug} — ${a.commits} task commit(s) since approval. ` +
      `Mark executing? mai_plan {path:"${a.path}", status:"executing"}`
  );
}

export function formatExecutedSuggestion(a: { slug: string; commits: number; path: string }): string {
  return capNoteBody(
    `${a.slug} — 0 open findings, ${a.commits} task commit(s) since approval. ` +
      `Mark executed? mai_plan {path:"${a.path}", status:"executed"}`
  );
}

function bodyFor(e: Evaluation): string {
  const a = { slug: e.plan.slug, commits: e.commits.length, path: e.plan.path };
  if (e.action === 'flip') return formatExecutingNote(a);
  if (e.action === 'suggest-executing') return formatExecutingSuggestion(a);
  if (e.action === 'suggest-executed') return formatExecutedSuggestion(a);
  throw new Error('retract actions have no post body');
}

async function candidatePlans(projectId: string, client: Queryable = getPool()): Promise<CandidateRow[]> {
  const r = await client.query<CandidateRow>(
    `SELECT p.id, p.slug, p.path, p.status,
            COALESCE(
              (SELECT max(rv.created_at) FROM plan_reviews rv
                WHERE rv.plan_id = p.id AND rv.verdict = 'approved'),
              p.created_at
            )::text AS anchor,
            (SELECT count(*) FROM plan_findings f
              WHERE f.plan_id = p.id AND f.status = 'open')::text AS open_findings
       FROM plans p
      WHERE p.project_id = $1
        AND (p.status IN ('approved', 'executing') OR p.board_thread_id IS NOT NULL)
      ORDER BY p.updated_at DESC`,
    [projectId]
  );
  return r.rows;
}

async function candidatePlan(
  projectId: string,
  planId: string,
  client: Queryable
): Promise<CandidateRow | null> {
  const r = await client.query<CandidateRow>(
    `SELECT p.id, p.slug, p.path, p.status,
            COALESCE(
              (SELECT max(rv.created_at) FROM plan_reviews rv
                WHERE rv.plan_id = p.id AND rv.verdict = 'approved'),
              p.created_at
            )::text AS anchor,
            (SELECT count(*) FROM plan_findings f
              WHERE f.plan_id = p.id AND f.status = 'open')::text AS open_findings
       FROM plans p
      WHERE p.project_id = $1 AND p.id = $2`,
    [projectId, planId]
  );
  return r.rows[0] ?? null;
}

/**
 * The repo-prefix map (spec §4.2, "umbrella path normalization" — load-bearing).
 * `plans.path` is resolved against projects.path, the UMBRELLA root, while
 * `commit_files.path` is repo-relative and `code_commits.repo_path` is the
 * absolute repo root. For a single-repo project the prefix is empty and the two
 * coincide; for an umbrella-class umbrella (`app/docs/…`) stripping the prefix
 * is the ONLY comparison that works.
 *
 * A registered repo physically OUTSIDE the umbrella (or an unavailable project
 * root) gets prefix null. R-A skips it entirely: the empty string is reserved
 * for the actual umbrella root, where repo-relative and plan-relative paths
 * genuinely share one namespace (ambiguity 10).
 */
async function repoPrefixes(projectId: string): Promise<RepoPrefix[]> {
  const roots = await loadProjectGraphRoots(projectId);
  const out: RepoPrefix[] = [];
  for (const repo of roots.repos) {
    const rel = path.relative(roots.productRoot, repo);
    const inside = rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    out.push({
      repo,
      aliases: [...new Set([repo, ...[...roots.aliases.rawToPhysical.entries()]
        .filter(([, physical]) => physical === repo)
        .map(([raw]) => raw)])],
      prefix: inside ? rel : null,
    });
  }
  return out;
}

/**
 * Commits that count as "plan-task commits" for this plan (spec §4.2), past the
 * anchor (§4.3). Two rules, unioned:
 *
 *  R-A (path) — the commit touched the plan file. The executor ticking a task
 *    checkbox is the canonical execution signal, and it is a FACT, not a guess.
 *  R-B (message) — the message/body names the slug or the plan-number token.
 *    Kept for the executor who commits code before ticking. Subjects in this
 *    repo do NOT reliably name their plan, so this supplements R-A; it is never
 *    the primary rule.
 *
 * The number arm uses Postgres ARE word boundaries (`\y`) so `plan-190` and
 * `replan-19` do not match `plan 19`; the slug arm uses position() rather than
 * LIKE because a filename-derived slug may contain `_`, a LIKE wildcard.
 */
async function matchingCommits(
  projectId: string,
  plan: CandidateRow,
  prefixes: RepoPrefix[],
  client: Queryable = getPool()
): Promise<CommitHit[]> {
  const hits = new Map<string, number>();

  for (const { aliases, prefix } of prefixes) {
    if (prefix === null) continue; // outside/unknown roots cannot satisfy R-A
    let rel: string | null = null;
    if (prefix === '') rel = plan.path;
    else if (plan.path.startsWith(prefix + '/')) rel = plan.path.slice(prefix.length + 1);
    if (rel === null) continue;
    const r = await client.query<{ id: string; at: string }>(
      `SELECT c.id, EXTRACT(EPOCH FROM COALESCE(c.committed_at, c.timestamp))::text AS at
         FROM commit_files f
         JOIN code_commits c ON c.id = f.commit_id
        WHERE f.project_id = $1 AND c.repo_path = ANY($2) AND f.path = $3
          AND NOT EXISTS (
            SELECT 1 FROM git_history_rewrites rw
            WHERE rw.commit_id = c.id AND rw.new_hash IS NULL
          )
          AND COALESCE(c.committed_at, c.timestamp) > $4::timestamptz`,
      [projectId, [...aliases], rel, plan.anchor]
    );
    for (const row of r.rows) hits.set(row.id, Number(row.at));
  }

  const token = planNumberToken(plan.slug);
  const r = await client.query<{ id: string; at: string }>(
    `SELECT c.id, EXTRACT(EPOCH FROM COALESCE(c.committed_at, c.timestamp))::text AS at
       FROM code_commits c
      WHERE c.project_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM git_history_rewrites rw
          WHERE rw.commit_id = c.id AND rw.new_hash IS NULL
        )
        AND COALESCE(c.committed_at, c.timestamp) > $2::timestamptz
        AND (position(lower($3) in lower(c.message)) > 0
             OR position(lower($3) in lower(COALESCE(c.body, ''))) > 0
             OR ($4::text IS NOT NULL
                 AND (c.message ~* $4 OR COALESCE(c.body, '') ~* $4)))`,
    [projectId, plan.anchor, plan.slug, token === null ? null : `\\yplan[ -]${token}\\y`]
  );
  for (const row of r.rows) hits.set(row.id, Number(row.at));

  return Array.from(hits, ([id, at]) => ({ id, at })).sort((a, b) => a.at - b.at);
}

/** Derive ONE action from one current candidate snapshot. The ingest pass uses
 * this first as a shortlist and then AGAIN inside postPlanNote/retractPlanNote
 * after their evidence-table + per-plan locks. The second result supplies the
 * exact body/ref; stale pre-lock actions are never delivered. */
async function evaluateCandidate(
  projectId: string,
  plan: CandidateRow,
  mode: PlanAutoAdvance,
  prefixes: RepoPrefix[],
  client: Queryable = getPool()
): Promise<Evaluation> {
  if (plan.status !== 'approved' && plan.status !== 'executing') {
    return { plan, commits: [], action: 'retract' };
  }
  const commits = await matchingCommits(projectId, plan, prefixes, client);
  if (commits.length === 0) return { plan, commits, action: 'retract' };
  if (plan.status === 'approved') {
    return { plan, commits, action: mode === 'auto' ? 'flip' : 'suggest-executing' };
  }
  if (Number(plan.open_findings) === 0) {
    return { plan, commits, action: 'suggest-executed' };
  }
  return { plan, commits, action: 'retract' };
}

async function evaluateOne(
  projectId: string,
  planId: string,
  mode: PlanAutoAdvance,
  prefixes: RepoPrefix[],
  client: Queryable
): Promise<Evaluation | null> {
  const plan = await candidatePlan(projectId, planId, client);
  return plan ? evaluateCandidate(projectId, plan, mode, prefixes, client) : null;
}

/** Shared read-only evaluation for the initial ingest shortlist and mai_prime. */
async function evaluate(
  projectId: string,
  mode: PlanAutoAdvance,
  prefixes: RepoPrefix[] = []
): Promise<Evaluation[]> {
  if (mode === 'off') return [];
  const plans = await candidatePlans(projectId);
  if (plans.length === 0) return [];
  const resolvedPrefixes = prefixes.length > 0 ? prefixes : await repoPrefixes(projectId);
  return Promise.all(
    plans.map((plan) => evaluateCandidate(projectId, plan, mode, resolvedPrefixes))
  );
}

/**
 * The ingest-chain pass. NEVER throws: it runs inside a hook that must exit 0,
 * so a failure degrades to a summary line. Returns one line for syncGit.
 */
export async function advancePlanLifecycle(projectId: string): Promise<string> {
  const mode = planAutoAdvanceMode();
  if (mode === 'off') return 'plan lifecycle [off]: disabled';
  try {
    const prefixes = await repoPrefixes(projectId);
    const evals = await evaluate(projectId, mode, prefixes);
    let flipped = 0;
    let posted = 0;
    let suppressed = 0;
    let retracted = 0;
    let taskInserted = 0;
    let taskExisting = 0;
    let taskBlocking = 0;
    let taskFollowUp = 0;
    const failures: string[] = [];
    for (const e of evals) {
      try {
        if (e.action === 'retract') {
          if (await retractPlanNote(
            e.plan.id,
            e.plan.slug,
            e.plan.path,
            async (client) => (await evaluateOne(
              projectId, e.plan.id, mode, prefixes, client
            ))?.action === 'retract'
          )) retracted++;
          continue;
        }
        const lifecycleRevalidate = async (
          client: PoolClient
        ): Promise<{ body: string; refs: PlanThreadRef[] } | null> => {
          const current = await evaluateOne(projectId, e.plan.id, mode, prefixes, client);
          if (!current || current.action !== e.action || current.commits.length === 0) return null;
          return {
            body: bodyFor(current),
            refs: [{ kind: 'commit', id: current.commits[0].id }],
          };
        };
        const result = await postPlanNote(
          e.plan.id,
          bodyFor(e),
          [{ kind: 'commit', id: e.commits[0].id }],
          {
            transitionApprovedToExecuting: e.action === 'flip',
            lifecycleRevalidate,
          }
        );
        if (result.delivery === 'stale') continue;
        if (result.transitioned) {
          flipped++;
          taskInserted += result.operator_tasks?.inserted ?? 0;
          taskExisting += result.operator_tasks?.existing ?? 0;
          taskBlocking += result.operator_tasks?.blocking ?? 0;
          taskFollowUp += result.operator_tasks?.follow_up ?? 0;
        }
        if (result.delivery === 'posted') posted++;
        else suppressed++;
      } catch (err) {
        failures.push(`${e.plan.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const lifecycle = `plan lifecycle [${mode}]: ${flipped} advanced to executing, ` +
      `${posted} note(s) posted, ${suppressed} suppressed, ` +
      `${retracted} stale prompt(s) retracted, ${failures.length} failed` +
      (failures.length > 0 ? ` (${failures.join('; ')})` : '');
    return flipped === 0 ? lifecycle : lifecycle +
      `\noperator tasks: ${taskInserted} inserted, ${taskExisting} existing; ` +
      `${taskBlocking} blocking, ${taskFollowUp} follow-up — My Tasks: http://127.0.0.1:6601/#/tasks`;
  } catch (err) {
    // Only evaluation-wide failures reach here. Per-candidate failures retain
    // the successes already committed and are reported in the aggregate above.
    return `plan lifecycle [${mode}]: skipped (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * mai_prime section (§4.5). READ-ONLY — a read path never flips anything, so in
 * `auto` mode an approved plan with matching commits (action 'flip') is
 * deliberately NOT rendered: the ingest-chain pass owns that move and
 * advertising it here would describe an action the server already takes.
 * Deliberately NOT added to primeStartupCompact — that path is budgeted under
 * 1,500 chars and is not the decision surface.
 */
export async function planLifecycleSection(
  projectId: string, charBudget?: number,
): Promise<string> {
  const mode = planAutoAdvanceMode();
  if (mode === 'off') return '';
  const evals = (await evaluate(projectId, mode)).filter(
    (e) => e.action === 'suggest-executing' || e.action === 'suggest-executed'
  );
  if (evals.length === 0) return '';
  const shown = evals.slice(0, SECTION_TOP_N);
  const heading = `## Plan lifecycle — ${evals.length} plan(s) awaiting a status call`;
  const renderFull = (rows: readonly Evaluation[]): string => [
    heading,
    '',
    ...rows.map((e) => `- ${bodyFor(e)}`),
    ...(evals.length > SECTION_TOP_N
      ? [`(… ${evals.length - SECTION_TOP_N} more — mai_plan)`]
      : []),
  ].join('\n');
  if (charBudget === undefined) return renderFull(shown);
  // The prime envelope's 300-character ceiling (plan 38): the producer owns it.
  return budgetRows(
    { fullRows: shown.length, charBudget }, shown, renderFull,
    (e) => `- ${headlineField(bodyFor(e), 120)}`, heading, 'plan',
    LIFECYCLE_NARROWING,
  );
}
