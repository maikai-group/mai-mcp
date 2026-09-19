// Parallel-agent path claims (decision b0fc1969): path-globs + one intent line
// per claim; overlap WARNS and never blocks (enforcement is impossible and
// undesirable — worktrees give physical isolation, claims give logical
// visibility). Heartbeat rides the piggyback-nudge wrapper: every tool call a
// working session makes refreshes its leases, so a crashed session's claims
// age out via TTL instead of holding a lane forever. All free text renders
// inside the untrusted frame — same quarantine discipline as the board.
import fs from 'node:fs';
import { getPool, getProjectId } from '../db.js';
import { PROJECT_ROOT } from '../env.js';
import { INSTANCE_SESSION, coordinationIdentity } from '../session-identity.js';
import { UNTRUSTED_FRAME, sanitizeBody, safeCoordAuthor } from './board.js';
import { enforceCharLimits } from '../write-gate.js';
import { headlineField } from '../read-budget.js';
import { demandCapPrimeMinimum, type PreparedPrimeText } from '../prime-budget.js';

const MAX_GLOBS = 16;
const MAX_GLOB_LEN = 512;
export const EXPIRE_HOURS = 8;
const QUIET_MINUTES = 60;
const NUDGE_THROTTLE_MS = 60_000;

/** Canonical on-disk path (casing + symlinks). macOS's case-insensitive FS
 * lets the same repo appear as .../Developer and .../developer — verbatim
 * storage would split claims across casings and the SQL repo_root equality
 * (overlap scoping) plus the hook's startsWith would silently miss (live
 * smoke finding, 8b T6). Nonexistent paths pass through verbatim. */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Text before the first wildcard — the checkable core of a glob. */
export function staticPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Advisory overlap: prefix containment both ways. Exact glob intersection is
 * not decidable cheaply; prefix containment catches the real cases (dir vs
 * dir, dir vs file) and is honest about being a heuristic. */
export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Does a repo-relative file path fall inside a claim glob? Exact globs match
 * the path itself or anything under it; wildcard globs match by static prefix. */
export function pathInGlob(relPath: string, glob: string): boolean {
  const p = staticPrefix(glob);
  if (p === glob) return relPath === glob || relPath.startsWith(glob.endsWith('/') ? glob : glob + '/');
  return relPath.startsWith(p);
}

function normalizeGlobs(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths: at least one repo-relative glob required (e.g. ["src/capture/**"]).');
  }
  if (paths.length > MAX_GLOBS) throw new Error(`paths: too many globs (${paths.length} > ${MAX_GLOBS}).`);
  return paths.map((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('paths: empty glob.');
    const g = raw.trim().replace(/^\.\//, '');
    if (g.length > MAX_GLOB_LEN) throw new Error(`paths: glob exceeds ${MAX_GLOB_LEN} chars.`);
    if (g.startsWith('/') || g.split('/').includes('..')) {
      throw new Error(`paths: '${g}' — repo-relative globs only (no absolute paths, no '..').`);
    }
    return g;
  });
}

interface ClaimRow {
  id: string;
  author_agent: string;
  author_session: string;
  repo_root: string;
  paths: string[];
  intent: string;
  status: string;
  created_at: string;
  last_heartbeat_at: string;
}

const CLAIM_COLS = `id, author_agent, author_session, repo_root, paths, intent, status,
                    created_at::text, last_heartbeat_at::text`;

async function expireStale(projectId: string): Promise<void> {
  await getPool().query(
    `UPDATE agent_claims SET status = 'expired'
     WHERE project_id = $1 AND status = 'active'
       AND last_heartbeat_at < now() - make_interval(hours => $2::int)`,
    [projectId, EXPIRE_HOURS]
  );
}

function quietTag(lastBeatIso: string): string {
  const mins = Math.floor((Date.now() - new Date(lastBeatIso).getTime()) / 60_000);
  if (mins < QUIET_MINUTES) return '';
  return mins < 120 ? ` (quiet ${mins}m)` : ` (quiet ${Math.floor(mins / 60)}h)`;
}

function fmtClaim(c: ClaimRow, ownSession: string): string {
  const who = c.author_session === ownSession ? `${safeCoordAuthor(c.author_agent)} (YOU)` : safeCoordAuthor(c.author_agent);
  const globs = c.paths.map((g) => sanitizeBody(g)).join(', ');
  return `- [${c.status}] ${who} since ${c.created_at.slice(0, 16)}${c.status === 'active' ? quietTag(c.last_heartbeat_at) : ''} — ${globs} — "${sanitizeBody(c.intent)}"\n  id: ${c.id}`;
}

/** Headline shape: paths and intent are field-capped SEPARATELY so one long
 * glob list cannot swallow the intent (or the reverse). Pure. */
function fmtClaimHeadline(c: ClaimRow, ownSession: string): string {
  const who = c.author_session === ownSession ? `${safeCoordAuthor(c.author_agent)} (YOU)` : safeCoordAuthor(c.author_agent);
  const globs = headlineField(c.paths.map((g) => sanitizeBody(g)).join(', '), 120);
  const intent = headlineField(sanitizeBody(c.intent), 120);
  return `- [${c.status}] ${who} since ${c.created_at.slice(0, 16)}${c.status === 'active' ? quietTag(c.last_heartbeat_at) : ''} — ${globs} — "${intent}"\n  id: ${c.id}`;
}

/** Overlap report for a set of globs vs other sessions' active claims. */
function findConflicts(globs: string[], others: ClaimRow[]): string[] {
  const conflicts: string[] = [];
  for (const o of others) {
    const hit = o.paths.find((og) => globs.some((g) => globsOverlap(g, og)));
    if (hit) {
      conflicts.push(`${safeCoordAuthor(o.author_agent)} ${o.id.slice(0, 8)} ('${sanitizeBody(hit)}') — "${sanitizeBody(o.intent)}"`);
    }
  }
  return conflicts;
}

export async function claimCreate(args: { paths: string[]; intent: string }): Promise<string> {
  const pool = getPool();
  const projectId = await getProjectId();
  if (!args.intent || !args.intent.trim()) {
    throw new Error('intent is required — one line: what you are doing in these paths.');
  }
  await enforceCharLimits({ fields: { intent: args.intent }, toolName: 'mai_claim' });
  const globs = normalizeGlobs(args.paths);
  const repoRoot = PROJECT_ROOT ? canonicalPath(PROJECT_ROOT) : '(unknown)';
  await expireStale(projectId);

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO agent_claims (project_id, repo_root, author_agent, author_session, server_pid, paths, intent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (author_session, md5(intent), md5(paths::text)) WHERE status = 'active' DO NOTHING
     RETURNING id`,
    [projectId, repoRoot, coordinationIdentity(), INSTANCE_SESSION, process.pid, JSON.stringify(globs), args.intent]
  );

  let claimId: string;
  let duplicate = false;
  if (inserted.rows.length === 0) {
    duplicate = true;
    const dupe = await pool.query<{ id: string }>(
      `SELECT id FROM agent_claims
       WHERE author_session = $1 AND md5(intent) = md5($2) AND md5(paths::text) = md5($3::jsonb::text)
         AND status = 'active'`,
      [INSTANCE_SESSION, args.intent, JSON.stringify(globs)]
    );
    if (dupe.rows.length === 0) return 'duplicate claim (id unresolvable) — not re-created.';
    claimId = dupe.rows[0].id;
    await pool.query(`UPDATE agent_claims SET last_heartbeat_at = now() WHERE id = $1`, [claimId]);
  } else {
    claimId = inserted.rows[0].id;
  }

  const others = await pool.query<ClaimRow>(
    `SELECT ${CLAIM_COLS} FROM agent_claims
     WHERE project_id = $1 AND status = 'active' AND author_session <> $2 AND repo_root = $3`,
    [projectId, INSTANCE_SESSION, repoRoot]
  );
  const conflicts = findConflicts(globs, others.rows);
  const head = duplicate ? `already claimed as ${claimId} (heartbeat refreshed)` : `claimed ${claimId} (${globs.length} glob(s))`;
  if (conflicts.length === 0) return `${head} — no overlap with other active claims.`;
  return [
    `${head}.`,
    `⚠ OVERLAP with other agents' active claims (advisory — warn, never block):`,
    ...conflicts.map((c) => `  - ${c}`),
    `Coordinate via mai_board_post before touching the shared paths; physical isolation needs worktree-per-agent.`,
  ].join('\n');
}

export async function claimRelease(args: {
  claimId?: string;
  all?: boolean;
  projectId?: string;
  anySession?: boolean; // CLI curation only — the MCP handler NEVER forwards this
}): Promise<string> {
  const pool = getPool();
  const projectId = args.projectId ?? (await getProjectId());
  if (!args.claimId && !args.all) throw new Error('release needs a claim id (release:<id>) or release_all:true.');
  const where = [`project_id = $1`, `status = 'active'`];
  const params: unknown[] = [projectId];
  if (!args.anySession) {
    params.push(INSTANCE_SESSION);
    where.push(`author_session = $${params.length}`);
  }
  if (args.claimId) {
    params.push(args.claimId);
    where.push(`id = $${params.length}`);
  }
  const r = await pool.query<{ id: string }>(
    `UPDATE agent_claims SET status = 'released', released_at = now() WHERE ${where.join(' AND ')} RETURNING id`,
    params
  );
  if (r.rows.length === 0) {
    return args.claimId
      ? `claim ${args.claimId} not found among YOUR active claims — sessions release only their own (a crashed session's claim expires after ${EXPIRE_HOURS}h quiet; cross-session cleanup: mai claims release <id>).`
      : 'no active claims of yours to release.';
  }
  return `released ${r.rows.length} claim(s): ${r.rows.map((x) => x.id.slice(0, 8)).join(', ')}`;
}

export async function claimsList(args: { status?: 'active' | 'all'; projectId?: string } = {}): Promise<string> {
  const pool = getPool();
  const projectId = args.projectId ?? (await getProjectId());
  await expireStale(projectId);
  const statusFilter = (args.status ?? 'active') === 'all' ? '' : `AND status = 'active'`;
  const rows = await pool.query<ClaimRow>(
    `SELECT ${CLAIM_COLS} FROM agent_claims
     WHERE project_id = $1 ${statusFilter}
     ORDER BY created_at DESC LIMIT 50`,
    [projectId]
  );
  if (rows.rows.length === 0) return 'No matching claims. Claim your lane: mai_claim {paths, intent}.';
  return [
    UNTRUSTED_FRAME,
    '',
    ...rows.rows.map((c) => fmtClaim(c, INSTANCE_SESSION)),
    '',
    'Overlaps are advisory — warn, never block. Coordinate via the board; pair with worktree-per-agent for physical isolation.',
    UNTRUSTED_FRAME,
  ].join('\n');
}

const CLAIMS_HEADING = `## Active path claims (parallel agents in this project)`;
/** Both frames are 381 characters together, so the ≤400 recovery minimum is the
 * frames plus the literal recovery route and nothing else. */
const CLAIMS_RECOVERY_MINIMUM = [UNTRUSTED_FRAME, 'mai_claims', UNTRUSTED_FRAME].join('\n');

/** Prime/startup section PREPARED: one expiry + one query, then pure rendering. */
export async function prepareClaimsPrimeSection(projectId: string): Promise<PreparedPrimeText> {
  const pool = getPool();
  await expireStale(projectId);
  const rows = await pool.query<ClaimRow>(
    `SELECT ${CLAIM_COLS} FROM agent_claims
     WHERE project_id = $1 AND status = 'active'
     ORDER BY created_at ASC LIMIT 8`,
    [projectId]
  );
  if (rows.rows.length === 0) return { minimum: '', full: '', render: () => '' };

  const full = [
    CLAIMS_HEADING,
    '',
    UNTRUSTED_FRAME,
    '',
    ...rows.rows.map((c) => fmtClaim(c, INSTANCE_SESSION)),
    '',
    UNTRUSTED_FRAME,
    '',
    `_Before working in a claimed area, coordinate via the board (warn-never-block). Claim your own lane: mai_claim {paths, intent}._`,
  ].join('\n');

  const headlines = rows.rows.map((c) => fmtClaimHeadline(c, INSTANCE_SESSION));
  const framed = (shown: readonly string[], withHeading: boolean): string => [
    ...(withHeading ? [CLAIMS_HEADING, ''] : []),
    UNTRUSTED_FRAME,
    ...(shown.length > 0 ? ['', ...shown, ''] : []),
    'mai_claims',
    UNTRUSTED_FRAME,
  ].join('\n');
  const minimum = demandCapPrimeMinimum(full, CLAIMS_RECOVERY_MINIMUM);

  return {
    minimum,
    full,
    render(charBudget?: number): string {
      if (charBudget === undefined || charBudget >= full.length) return full;
      if (minimum === full) return full;
      // Heading and headline rows appear only while the share has room; the two
      // frames never leave.
      for (const withHeading of [true, false]) {
        for (let n = headlines.length; n >= 0; n--) {
          const candidate = framed(headlines.slice(0, n), withHeading);
          if (candidate.length <= charBudget) return candidate;
        }
      }
      return minimum;
    },
  };
}

/** Prime/startup section: active claims, oldest first. '' when none. */
export async function claimsPrimeSection(projectId: string): Promise<string> {
  return (await prepareClaimsPrimeSection(projectId)).full;
}

/** Count of active claims — for the compact startup briefing. Expires stale first. */
export async function claimsActiveCount(projectId: string): Promise<number> {
  await expireStale(projectId);
  const r = await getPool().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM agent_claims WHERE project_id = $1 AND status = 'active'`,
    [projectId]
  );
  return Number(r.rows[0].n);
}

let lastBeatMs = 0;
let watermarkIso = new Date().toISOString();

/** Test-only: reset the throttle (and the watermark when given). The no-arg
 * form deliberately KEEPS the watermark — it only ever advances from DB
 * timestamps, so mixing in the JS clock here would reintroduce the host↔DB
 * clock-skew race the watermark design avoids. */
export function _resetClaimsNudgeState(watermark?: string): void {
  lastBeatMs = 0;
  if (watermark !== undefined) watermarkIso = watermark;
}

/**
 * Heartbeat + conflict delta, riding the piggyback-nudge wrapper (decision
 * b0fc1969): each tool call (throttled to one DB pass per minute) refreshes
 * this session's leases and reports NEW overlapping claims by other sessions
 * since the last check. Returns '' when quiet; never throws to the wrapper.
 */
export async function claimsBeatAndNudge(): Promise<string> {
  const now = Date.now();
  if (now - lastBeatMs < NUDGE_THROTTLE_MS) return '';
  lastBeatMs = now;

  const pool = getPool();
  const projectId = await getProjectId();
  await expireStale(projectId);
  await pool.query(
    `UPDATE agent_claims SET last_heartbeat_at = now() WHERE author_session = $1 AND status = 'active'`,
    [INSTANCE_SESSION]
  );

  const fresh = await pool.query<ClaimRow>(
    `SELECT ${CLAIM_COLS} FROM agent_claims
     WHERE project_id = $1 AND status = 'active' AND author_session <> $2
       AND created_at > $3::timestamptz
     ORDER BY created_at ASC`,
    [projectId, INSTANCE_SESSION, watermarkIso]
  );
  if (fresh.rows.length === 0) return '';
  watermarkIso = fresh.rows[fresh.rows.length - 1].created_at;

  const mine = await pool.query<{ paths: string[] }>(
    `SELECT paths FROM agent_claims WHERE author_session = $1 AND status = 'active'`,
    [INSTANCE_SESSION]
  );
  if (mine.rows.length === 0) return '';
  const myGlobs = mine.rows.flatMap((m) => m.paths);
  const hits = fresh.rows.filter((o) => o.paths.some((og) => myGlobs.some((mg) => globsOverlap(mg, og))));
  if (hits.length === 0) return '';
  const parts = hits.map(
    (h) => `${safeCoordAuthor(h.author_agent)} claimed ${h.paths.map((g) => sanitizeBody(g)).join(',')} (${h.id.slice(0, 8)})`
  );
  return `[claims: ⚠ ${parts.join('; ')} — overlaps your active claim(s). Advisory only; coordinate via the board. Detail: mai_claims.]`;
}
