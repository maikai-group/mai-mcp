// One-shot machine-readable reads for external services
// (conductor-machine-contract/2; consumers: M-AI5 conductor, M-AI5 Plan-2
// status panel). argv: <fn> <json-args>. The project pin is enforced BEFORE
// any DB access by a pure check of PROJECT_SLUG — requirePinnedSlug() itself
// cannot be used here because it is entrypoint-fatal (src/env.ts:45-58 logs
// and process.exit(1)s, breaking both the typed exit contract and the
// no-process.exit rule; pass-4 finding c7e69e38). A missing/empty/malformed
// MAI_PROJECT_SLUG is a configuration error (exit 2), never a query against
// the live-default DB and never a db-failure exit (pass-3 finding c2901e76).
// stdout carries exactly one JSON document; diagnostics go to stderr.
// Termination MUST drain the event loop (finishAndExit): process.exit() after
// a stdout write truncates piped output at one pipe buffer on macOS.
import { pathToFileURL } from 'node:url';
import { getPool, getProjectId, dbErrorHint } from './db.js';
import { PROJECT_SLUG } from './env.js';
import { EXIT } from './code-findings.js';
import { finishAndExit } from './exit.js';
import { readBuildInfo } from './build-info.js';
import { receiptsQuery, streamTag, encodeCursor, decodeCursor, ReceiptValidationError } from './receipts.js';
import { artifactGet, ArtifactValidationError, ArtifactNotFoundError } from './artifacts.js';

export const CONTRACT_VERSION = 'conductor-machine-contract/2';
export const READ_CALL_FNS = ['ping', 'plan_state', 'findings', 'receipts', 'review_state', 'board_thread', 'artifact'] as const;
export const BOARD_PAGE_MAX = 200;
export const BOARD_PAGE_DEFAULT = 100;

export class ReadCallError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'ReadCallError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) {
    throw new ReadCallError(EXIT.VALIDATION, `${key} required (string, 1-1000 chars)`);
  }
  return value;
}
/** EXIT.PROJECT_MISMATCH is the REAL cross-project case: the addressed record
 * exists — under someone else's project (src/code-findings.ts:24-37). */
async function raiseMismatchOrNotFound(existsElsewhere: boolean, what: string): Promise<never> {
  if (existsElsewhere) throw new ReadCallError(EXIT.PROJECT_MISMATCH, `${what} exists under another project`);
  throw new ReadCallError(EXIT.NOT_FOUND, `${what} not found`);
}

/** Contract + build fingerprint: what consumers pin in their companion lock. */
export async function ping(): Promise<Record<string, unknown>> {
  const projectId = await getProjectId();
  const build = await readBuildInfo();
  return {
    ok: true,
    contract: CONTRACT_VERSION,
    projectId,
    build: build === null ? null
      : { version: build.version, sha: build.sha, dirty: build.dirty, builtAt: build.builtAt },
  };
}

export async function planState(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const path = requireString(args, 'path');
  const pool = getPool();
  const projectId = await getProjectId();
  const { rows: plans } = await pool.query<{ id: string; path: string; status: string; current_sha: string | null }>(
    'SELECT id, path, status, current_sha FROM plans WHERE project_id = $1 AND path = $2',
    [projectId, path]);
  if (plans.length === 0) throw new ReadCallError(EXIT.NOT_FOUND, `plan not registered: ${path}`);
  const plan = plans[0];
  const { rows: passes } = await pool.query<{ pass: number; kind: string; verdict: string; plan_sha: string | null; reviewer_agent: string }>(
    'SELECT pass, kind, verdict, plan_sha, reviewer_agent FROM plan_reviews WHERE plan_id = $1 ORDER BY pass',
    [plan.id]);
  const { rows: findings } = await pool.query<{ id: string; severity: string; title: string; status: string }>(
    'SELECT id, severity, title, status FROM plan_findings WHERE plan_id = $1 ORDER BY created_at',
    [plan.id]);
  return {
    planId: plan.id, path: plan.path, status: plan.status, currentSha: plan.current_sha,
    passes: passes.map((p) => ({
      pass: p.pass, kind: p.kind, verdict: p.verdict, planSha: p.plan_sha, reviewerAgent: p.reviewer_agent })),
    findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, status: f.status })),
  };
}

const UUID_ARG_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function requireUuid(value: string, what: string): string {
  const normalized = value.toLowerCase();
  if (!UUID_ARG_PATTERN.test(normalized)) {
    throw new ReadCallError(EXIT.VALIDATION, `${what} must be a UUID`);
  }
  return normalized;
}

export async function findingsRead(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // UUID params are validated first and compared NATIVELY (`col = $n::uuid`) —
  // casting the COLUMN to text defeats its btree/PK index (pass-7 finding
  // d85b027f, applied class-wide).
  const planId = args.plan_id;
  const ids = args.ids;
  const pool = getPool();
  const projectId = await getProjectId();
  if (typeof planId === 'string' && planId.length > 0) {
    const planUuid = requireUuid(planId, 'plan_id');
    // An empty result is only honest when the plan itself is OURS: probe plan
    // ownership so a foreign plan UUID is exit 4, an unknown one exit 3, and
    // a registered-but-findingless plan a legitimate empty list (pass-4
    // finding 7dcdd3f9).
    const { rows: owned } = await pool.query<{ id: string }>(
      'SELECT id FROM plans WHERE project_id = $1 AND id = $2::uuid', [projectId, planUuid]);
    if (owned.length === 0) {
      const { rows: elsewhere } = await pool.query<{ id: string }>(
        'SELECT id FROM plans WHERE project_id <> $1 AND id = $2::uuid LIMIT 1', [projectId, planUuid]);
      await raiseMismatchOrNotFound(elsewhere.length > 0, `plan ${planUuid}`);
    }
    const { rows } = await pool.query(
      `SELECT id, severity, title, location, issue, evidence, fix, status, resolution_note
       FROM plan_findings WHERE project_id = $1 AND plan_id = $2::uuid ORDER BY created_at`,
      [projectId, planUuid]);
    return { findings: rows };
  }
  if (Array.isArray(ids) && ids.length > 0 && ids.length <= 128 && ids.every((v) => typeof v === 'string')) {
    // missingIds preserves the CALLER'S tokens: original spelling, original
    // request order, exact-duplicate tokens collapsed only. Lowercasing is a
    // lookup normalization, never applied to what we echo back — mutating or
    // reordering caller tokens made responses unmatchable against the request
    // (pass-8 finding e4f3acff). Malformed tokens can never exist in any
    // project, so they skip the mismatch probe and land in missingIds as sent.
    const requested: string[] = [];
    const seenTokens = new Set<string>();
    for (const v of ids) {
      const token = String(v);
      if (!seenTokens.has(token)) { seenTokens.add(token); requested.push(token); }
    }
    const validIds = [...new Set(
      requested.map((token) => token.toLowerCase()).filter((id) => UUID_ARG_PATTERN.test(id)))];
    const rows = validIds.length === 0 ? [] : (await pool.query<{ id: string; severity: string; title: string; location: string; issue: string; evidence: string; fix: string; status: string; resolution_note: string | null }>(
      `SELECT id, severity, title, location, issue, evidence, fix, status, resolution_note
       FROM plan_findings WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY created_at`,
      [projectId, validIds])).rows;
    // Probe the NOT-FOUND SUBSET always — one local hit must not suppress the
    // mismatch signal for a foreign id riding in the same request (pass-4
    // finding 7dcdd3f9). Any missing id that exists under another project is
    // exit 4; ids existing nowhere are reported in missingIds, not dropped.
    const foundIds = new Set(rows.map((r) => r.id));
    const missingValid = validIds.filter((id) => !foundIds.has(id));
    if (missingValid.length > 0) {
      const { rows: elsewhere } = await pool.query<{ id: string }>(
        'SELECT id FROM plan_findings WHERE project_id <> $1 AND id = ANY($2::uuid[]) LIMIT 1',
        [projectId, missingValid]);
      if (elsewhere.length > 0) await raiseMismatchOrNotFound(true, 'requested finding(s)');
    }
    const missingIds = requested.filter((token) => {
      const normalized = token.toLowerCase();
      return !UUID_ARG_PATTERN.test(normalized) || !foundIds.has(normalized);
    });
    return { findings: rows, missingIds };
  }
  throw new ReadCallError(EXIT.VALIDATION, 'plan_id or ids[] (1-128 strings) required');
}

export async function reviewState(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reviewId = requireUuid(requireString(args, 'review_id'), 'review_id');
  const pool = getPool();
  const projectId = await getProjectId();
  const { rows } = await pool.query<{ id: string; pass: number; kind: string; verdict: string; plan_sha: string | null; reviewer_agent: string; plan_id: string }>(
    `SELECT r.id, r.pass, r.kind, r.verdict, r.plan_sha, r.reviewer_agent, r.plan_id
     FROM plan_reviews r JOIN plans p ON p.id = r.plan_id
     WHERE p.project_id = $1 AND r.id = $2::uuid`, [projectId, reviewId]);
  if (rows.length === 0) {
    const { rows: elsewhere } = await pool.query<{ id: string }>(
      `SELECT r.id FROM plan_reviews r JOIN plans p ON p.id = r.plan_id
       WHERE p.project_id <> $1 AND r.id = $2::uuid LIMIT 1`, [projectId, reviewId]);
    await raiseMismatchOrNotFound(elsewhere.length > 0, `review ${reviewId}`);
  }
  const review = rows[0];
  const { rows: findings } = await pool.query<{ id: string; severity: string; status: string }>(
    'SELECT id, severity, status FROM plan_findings WHERE review_id = $1 ORDER BY created_at',
    [review.id]);
  return {
    reviewId: review.id, pass: review.pass, kind: review.kind, verdict: review.verdict,
    planId: review.plan_id, planSha: review.plan_sha, reviewerAgent: review.reviewer_agent,
    findings,
  };
}

export async function boardThread(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const threadId = requireUuid(requireString(args, 'thread_id'), 'thread_id');
  const limitRaw = args.limit;
  let limit = BOARD_PAGE_DEFAULT;
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > BOARD_PAGE_MAX) {
      throw new ReadCallError(EXIT.VALIDATION, `limit must be an integer 1-${BOARD_PAGE_MAX}`);
    }
    limit = limitRaw;
  }
  const pool = getPool();
  const projectId = await getProjectId();
  const tag = streamTag('thread', threadId, projectId);
  let after: { ts: string; id: string } | null = null;
  if (args.cursor !== undefined) after = decodeCursor(args.cursor, tag);
  const params: (string | number)[] = [projectId, threadId];
  let where = `project_id = $1 AND (id = $2::uuid OR thread_id = $2::uuid)`;
  if (after !== null) {
    params.push(after.ts, after.id);
    where += ` AND (created_at, id) > ($3::timestamptz, $4::uuid)`;
  }
  params.push(limit + 1);
  const { rows } = await pool.query<{ id: string; cursor_ts: string; thread_id: string | null; type: string; status: string; author_agent: string; body: string; refs: unknown; created_at: Date }>(
    `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
            thread_id, type, status, author_agent, body, refs, created_at
     FROM agent_messages WHERE ${where} ORDER BY created_at, id LIMIT $${params.length}`, params);
  if (rows.length === 0 && after === null) {
    const { rows: elsewhere } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_messages WHERE project_id <> $1 AND (id = $2::uuid OR thread_id = $2::uuid) LIMIT 1`,
      [projectId, threadId]);
    await raiseMismatchOrNotFound(elsewhere.length > 0, `board thread ${threadId}`);
  }
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length > 0
    ? encodeCursor(tag, page[page.length - 1].cursor_ts, page[page.length - 1].id)
    : null;
  return {
    messages: page.map((m) => ({
      id: m.id, threadId: m.thread_id, type: m.type, status: m.status,
      authorAgent: m.author_agent, body: m.body, refs: m.refs, createdAt: m.created_at })),
    nextCursor,
  };
}

export async function artifactRead(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const result = await artifactGet(args);
    return { kind: result.kind, sha256: result.sha256, byteLength: result.byteLength, content: result.content };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError && typeof args.sha256 === 'string') {
      const pool = getPool();
      const projectId = await getProjectId();
      const { rows: elsewhere } = await pool.query<{ id: string }>(
        'SELECT id FROM run_artifacts WHERE project_id <> $1 AND sha256 = $2 LIMIT 1',
        [projectId, args.sha256]);
      await raiseMismatchOrNotFound(elsewhere.length > 0, `artifact ${args.sha256}`);
    }
    throw error;
  }
}

export async function dispatch(fn: string, args: Record<string, unknown>): Promise<unknown> {
  if (fn === 'ping') return ping();
  if (fn === 'plan_state') return planState(args);
  if (fn === 'findings') return findingsRead(args);
  if (fn === 'receipts') return receiptsQuery(args);
  if (fn === 'review_state') return reviewState(args);
  if (fn === 'board_thread') return boardThread(args);
  if (fn === 'artifact') return artifactRead(args);
  throw new ReadCallError(EXIT.VALIDATION, `unknown fn: ${fn} (${READ_CALL_FNS.join('|')})`);
}

/** Runs one read and returns the process exit code; never calls process.exit. */
export async function main(argv: string[]): Promise<number> {
  // Pin gate FIRST — before argument parsing touches anything DB-shaped and
  // before any pool exists. Pure check of the same invariant requirePinnedSlug
  // enforces (that function process.exit(1)s and can never return exit 2).
  if (!PROJECT_SLUG.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(PROJECT_SLUG)) {
    process.stderr.write(
      'MAI_PROJECT_SLUG is missing, empty, or not lowercase kebab-case; set it in the consumer project env\n');
    return EXIT.VALIDATION;
  }
  const fn = argv[2];
  if (typeof fn !== 'string' || fn.length === 0) {
    process.stderr.write(`fn required (${READ_CALL_FNS.join('|')})\n`);
    return EXIT.VALIDATION;
  }
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argv[3] ?? '{}');
    if (!isRecord(parsed)) throw new Error('not an object');
    args = parsed;
  } catch {
    process.stderr.write('second argument must be a JSON object\n');
    return EXIT.VALIDATION;
  }
  try {
    const out = await dispatch(fn, args);
    process.stdout.write(JSON.stringify(out) + '\n');
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ReadCallError) { process.stderr.write(error.message + '\n'); return error.code; }
    if (error instanceof ReceiptValidationError || error instanceof ArtifactValidationError) {
      process.stderr.write(error.message + '\n');
      return EXIT.VALIDATION;
    }
    if (error instanceof ArtifactNotFoundError) { process.stderr.write(error.message + '\n'); return EXIT.NOT_FOUND; }
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Project not found for pinned slug')) {
      process.stderr.write(message + '\n');
      return EXIT.VALIDATION;
    }
    const hint = dbErrorHint(error);
    process.stderr.write(`${message}${hint === null ? '' : `\n${hint}`}\n`);
    return EXIT.DB;
  }
}

// Entry guard (stamp-build.mjs precedent): importing this module in tests runs
// nothing; only direct execution dispatches and exits.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv);
  await finishAndExit(code);
}
