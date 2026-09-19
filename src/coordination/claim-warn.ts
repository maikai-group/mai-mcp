// PreToolUse(Edit|Write|MultiEdit|NotebookEdit) hook — advisory claim-overlap
// warning (decision b0fc1969: warn, NEVER block). Emits additionalContext
// ONLY — deliberately no permissionDecision, so the user's permission flow is
// completely untouched. Own-session claims are suppressed via sibling-PID
// detection: this hook and the session's mai-mcp server are both children of
// the same Claude Code process, and claims record their server's pid. Every
// failure path exits 0 silently, and a hard 2.5s timer guarantees an edit is
// never stalled — an advisory hook must not have a failure mode.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { getPool, resolveProjectId } from '../db.js';
import { pathInGlob } from './claims.js';
import { defaultProcessOps } from '../platform/processes.js';
import type { ProcessOps } from '../platform/processes.js';

interface HookInput {
  tool_input?: { file_path?: string; notebook_path?: string };
}

export interface ActiveClaim {
  id: string;
  author_agent: string;
  server_pid: number;
  repo_root: string;
  paths: string[];
  intent: string;
  created_at: string;
}

export function relativeClaimPath(file: string, root: string, windows: boolean): string | null {
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(file) || !api.isAbsolute(root)) return null;
  if (windows && (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(file)
      || !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(root))) return null;
  const relative = api.relative(root, file).replaceAll('\\', '/');
  if (!relative || api.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) return null;
  return windows ? relative.toLowerCase() : relative;
}

/** Claims whose globs cover this canonical absolute file path. */
export function matchClaims(
  filePath: string, claims: ActiveClaim[], windows = process.platform === 'win32',
): ActiveClaim[] {
  return claims.filter((c) => {
    if (c.repo_root === '(unknown)') return false;
    const rel = relativeClaimPath(filePath, c.repo_root, windows);
    return rel !== null && c.paths.some(g => pathInGlob(rel, windows ? g.toLowerCase() : g));
  });
}

export function selectOwnServerPids(
  hookAncestors: readonly number[] | null,
  parents: ReadonlyMap<number, number | null>,
): Set<number> {
  if (!hookAncestors) return new Set();
  const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 1;
  if (hookAncestors.some(pid => !Number.isSafeInteger(pid) || pid < 1)
      || new Set(hookAncestors).size !== hookAncestors.length) return new Set();
  const candidates: Array<readonly [number, number]> = [];
  for (const [pid, parent] of parents) {
    if (valid(pid) && parent !== null && valid(parent) && pid !== parent && hookAncestors.includes(parent)) {
      candidates.push([pid, parent]);
    }
  }
  const nearest = Math.min(...candidates.map(([, parent]) => hookAncestors.indexOf(parent)));
  return new Set(candidates.filter(([, parent]) => hookAncestors.indexOf(parent) === nearest)
    .map(([pid]) => pid));
}

/** mai-mcp server pids that are siblings of this hook (same Claude Code
 * parent) — those are THIS session's servers, and their claims are our own. */
export function siblingServerPids(psOutput: string, grandparentPid: number): Set<number> {
  const pids = new Set<number>();
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m && Number(m[2]) === grandparentPid && m[3].includes('build/index.js')) pids.add(Number(m[1]));
  }
  return pids;
}

async function withinDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) throw new Error('claim ownership deadline exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('claim ownership deadline exceeded')), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function ownServerPids(
  rows: readonly { server_pid: number }[], processOps: Pick<ProcessOps, 'ancestorPids' | 'processBirthId'>,
  hookPid = process.pid, deadlineMs = 4_000,
): Promise<Set<number>> {
  const candidates = [...new Set(rows.map(row => row.server_pid))]
    .filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== hookPid);
  if (candidates.length > 128) return new Set();
  const started = Date.now();
  const remaining = () => deadlineMs - (Date.now() - started);
  const hookAncestors = await withinDeadline(processOps.ancestorPids(hookPid), remaining()).catch(() => null);
  if (!hookAncestors) return new Set();
  const parents = new Map<number, number | null>();
  for (let offset = 0; offset < candidates.length; offset += 4) {
    if (remaining() <= 0) return new Set();
    await Promise.all(candidates.slice(offset, offset + 4).map(async pid => {
      try {
        const beforePid = await withinDeadline(processOps.processBirthId(pid), remaining());
        const ancestors = await withinDeadline(processOps.ancestorPids(pid), remaining());
        const parent = ancestors?.[0] ?? null;
        if (beforePid === null || parent === null || parent <= 1) return;
        const beforeParent = await withinDeadline(processOps.processBirthId(parent), remaining());
        const afterPid = await withinDeadline(processOps.processBirthId(pid), remaining());
        const afterParent = await withinDeadline(processOps.processBirthId(parent), remaining());
        if (beforeParent !== null && beforePid === afterPid && beforeParent === afterParent) parents.set(pid, parent);
      } catch {
        // Unknown identity never authorizes suppression.
      }
    }));
  }
  return remaining() <= 0 ? new Set() : selectOwnServerPids(hookAncestors, parents);
}

interface OwnershipWorkerData {
  kind: 'claim-ownership';
  pids: readonly number[];
  hookPid: number;
  deadlineMs: number;
}

type OwnershipWorkerFactory = (data: OwnershipWorkerData) => Worker;

/** Put synchronous OS probes behind a worker boundary so the hook's parent
 * event loop can enforce a real wall-clock deadline and terminate the probe. */
export function boundedOwnServerPidsInWorker(
  rows: readonly { server_pid: number }[], hookPid: number, deadlineMs: number,
  createWorker: OwnershipWorkerFactory = data => new Worker(new URL(import.meta.url), { workerData: data }),
): Promise<Set<number>> {
  const data: OwnershipWorkerData = {
    kind: 'claim-ownership', pids: rows.map(row => row.server_pid), hookPid, deadlineMs,
  };
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: Worker;
    const finish = (pids: Set<number>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve(pids);
    };
    try {
      worker = createWorker(data);
    } catch {
      resolve(new Set());
      return;
    }
    timer = setTimeout(() => finish(new Set()), deadlineMs);
    worker.once('message', (value: unknown) => {
      if (!Array.isArray(value) || value.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) {
        finish(new Set());
        return;
      }
      finish(new Set(value));
    });
    worker.once('error', () => finish(new Set()));
    worker.once('exit', () => finish(new Set()));
  });
}

export function canonicalClaimPath(rawPath: string, platform: NodeJS.Platform): string | null {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (!api.isAbsolute(rawPath)) return null;
  if (platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(rawPath)) return null;
  const missing: string[] = [];
  let probe = rawPath;
  for (;;) {
    try {
      const physical = fs.realpathSync.native(probe);
      return api.join(physical, ...missing.reverse());
    } catch (error) {
      if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') return null;
      const parent = api.dirname(probe);
      if (parent === probe) return null;
      missing.push(api.basename(probe));
      probe = parent;
    }
  }
}

export interface ClaimWarnOps {
  platform: NodeJS.Platform;
  hookPid: number;
  process: Pick<ProcessOps, 'ancestorPids' | 'processBirthId'>;
  resolveOwnership?(rows: readonly { server_pid: number }[]): Promise<Set<number>>;
  canonicalize(rawPath: string, platform: NodeJS.Platform): string | null;
  resolveProject(slug: string): Promise<string>;
  listClaims(projectId: string): Promise<ActiveClaim[]>;
  touch(projectId: string, pids: readonly number[]): Promise<number>;
  deadlineMs: number;
}

function defaultClaimWarnOps(): ClaimWarnOps {
  return {
    platform: process.platform,
    hookPid: process.pid,
    process: defaultProcessOps(),
    resolveOwnership: rows => boundedOwnServerPidsInWorker(rows, process.pid, 4_000),
    canonicalize: canonicalClaimPath,
    resolveProject: resolveProjectId,
    listClaims: async (projectId) => (await getPool().query<ActiveClaim>(
      `SELECT id, author_agent, server_pid, repo_root, paths, intent, created_at::text
       FROM agent_claims
       WHERE project_id = $1 AND status = 'active'
         AND last_heartbeat_at > now() - make_interval(hours => 8)`,
      [projectId],
    )).rows,
    touch: touchOwnClaims,
    deadlineMs: 4_000,
  };
}

/** Evaluate one pre-edit payload. Returns advisory JSON or null; never grants or denies permission. */
export async function runClaimWarn(raw: string, slug: string, ops = defaultClaimWarnOps()): Promise<string | null> {
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
  const rawPath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!rawPath) return null;
  const filePath = ops.canonicalize(rawPath, ops.platform);
  if (filePath === null) return null;
  const projectId = await ops.resolveProject(slug);
  const rawClaims = await ops.listClaims(projectId);
  const claims = rawClaims.map((claim) => ({
    ...claim,
    repo_root: ops.canonicalize(claim.repo_root, ops.platform) ?? '(unknown)',
  }));
  const own = ops.resolveOwnership
    ? await ops.resolveOwnership(claims)
    : await ownServerPids(claims, ops.process, ops.hookPid, ops.deadlineMs);
  await ops.touch(projectId, [...own]);
  const hits = matchClaims(filePath, claims, ops.platform === 'win32').filter((claim) => !own.has(claim.server_pid));
  if (hits.length === 0) return null;
  const detail = hits
    .map((hit) => `${hit.author_agent} (${hit.id.slice(0, 8)}, since ${hit.created_at.slice(0, 16)}): "${hit.intent.replace(/\s+/g, ' ').slice(0, 200)}"`)
    .join('; ');
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `⚠ mai claims (advisory — warn, never block): ${filePath} is inside another agent's active claim — ${detail}. Check mai_claims and coordinate via the agent board before proceeding.`,
    },
  });
}

/** Refresh the session's own leases from the edit path. The piggyback wrapper
 * only heartbeats on mai_* tool calls — a session editing heads-down for hours
 * without brain tools would watch its own claims expire (retro gap,
 * 2026-07-10). Every Edit/Write already runs this hook, and the sibling-PID
 * set identifies which claims are ours. */
export async function touchOwnClaims(projectId: string, pids: readonly number[]): Promise<number> {
  if (pids.length === 0) return 0;
  const r = await getPool().query(
    `UPDATE agent_claims SET last_heartbeat_at = now()
     WHERE project_id = $1 AND status = 'active' AND server_pid = ANY($2::int[])`,
    [projectId, [...pids]]
  );
  return r.rowCount ?? 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main(): Promise<void> {
  // Hard ceiling: an advisory hook may never stall an edit. A timeout is
  // LOGGED (stderr → /tmp/mai-claim-warn.log) — a silently dropped warning on
  // a cold start is otherwise indistinguishable from "no claims" (live smoke
  // finding, 8b T6: cold node+pg+ps crossed the original 2.5s ceiling).
  const guard = setTimeout(() => {
    console.error(`claim-warn: timed out (4s) — warning dropped (advisory; edit not blocked)`);
    process.exit(0);
  }, 4000);

  try {
    const slug = process.env.MAI_PROJECT_SLUG;
    if (!slug) return;
    const raw = await readStdin();
    const output = await runClaimWarn(raw, slug);
    if (output !== null) console.log(output);
  } catch {
    // silent by contract
  } finally {
    clearTimeout(guard);
    try {
      await getPool().end();
    } catch {
      // pool may never have opened
    }
    process.exit(0);
  }
}

function isOwnershipWorkerData(value: unknown): value is OwnershipWorkerData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const pids = Reflect.get(value, 'pids');
  const hookPid = Reflect.get(value, 'hookPid');
  const deadlineMs = Reflect.get(value, 'deadlineMs');
  return Reflect.get(value, 'kind') === 'claim-ownership'
    && Array.isArray(pids) && pids.every(pid => Number.isSafeInteger(pid) && pid > 1)
    && Number.isSafeInteger(hookPid) && typeof hookPid === 'number' && hookPid > 1
    && Number.isSafeInteger(deadlineMs) && typeof deadlineMs === 'number' && deadlineMs > 0;
}

if (!isMainThread && parentPort && isOwnershipWorkerData(workerData)) {
  const rows = workerData.pids.map(server_pid => ({ server_pid }));
  const result = await ownServerPids(rows, defaultProcessOps(), workerData.hookPid, workerData.deadlineMs)
    .catch(() => new Set<number>());
  parentPort.postMessage([...result]);
  parentPort.close();
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
