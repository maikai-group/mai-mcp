// Git primitives for the semantic evidence layer. Pure parsers + execFile-array
// wrappers (T6 — never a shell string with interpolated paths). Postgres is the
// index; these functions are the live-hydration side. Patches are returned to
// callers, NEVER persisted (spec §5).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const MAX_GIT_BUFFER = 256 * 1024 * 1024;

/** Bound on any single git subprocess (full-history log --numstat on a large
 * repo is the slow case; the bound exists to kill hangs, not shave latency). */
export const GIT_EXEC_TIMEOUT_MS = 60_000;

/** execFile with a default timeout — a hung git (lock, credential prompt,
 * network remote) must fail, never freeze the tool call. Callers may override. */
export function execBounded(
  cmd: string,
  args: string[],
  opts: { timeout?: number; killSignal?: NodeJS.Signals; maxBuffer?: number; cwd?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFileP(cmd, args, { timeout: GIT_EXEC_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts });
}

const exec = execBounded;

export interface GitFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number | null; // null for binary
  deletions: number | null;
  isBinary: boolean;
}

export interface GitCommit {
  hash: string;
  parents: string[];
  authoredAt: string;   // %aI
  committedAt: string;  // %cI
  author: string;
  subject: string;
  body: string;
  files: GitFileChange[];
}

// Known limit: a commit body literally containing a sentinel garbles that one
// commit's parse (it degrades to a dropped entry, never a crash). Accepted —
// the tokens are improbable in real messages.
const COMMIT_SENTINEL = '@@MAI-COMMIT@@';
const BODY_SENTINEL = '@@MAI-BODY@@';
const ENDBODY_SENTINEL = '@@MAI-ENDBODY@@';

const PRETTY = [
  `${COMMIT_SENTINEL}%n`,
  `%H%x09%P%x09%aI%x09%cI%x09%an%n`,
  `%s%n`,
  `${BODY_SENTINEL}%n`,
  `%b${ENDBODY_SENTINEL}`,
].join('');

/**
 * Expand git's rename syntax — both forms: "src/{old => new}/x.ts" (common
 * prefix/suffix) and the brace-less "a.ts => b.ts" (no common parts; without
 * this, the raw string became a phantom modified-file row — review finding).
 */
export function expandRenamePath(raw: string): { oldPath: string; newPath: string } {
  const braced = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) {
    const join = (mid: string): string => (braced[1] + mid + braced[4]).replace(/\/\//g, '/');
    return { oldPath: join(braced[2]), newPath: join(braced[3]) };
  }
  const plain = raw.match(/^(.+) => (.+)$/);
  if (plain) return { oldPath: plain[1], newPath: plain[2] };
  return { oldPath: raw, newPath: raw };
}

function statusFromRaw(letter: string): GitFileChange['status'] {
  if (letter.startsWith('A')) return 'added';
  if (letter.startsWith('D')) return 'deleted';
  if (letter.startsWith('R')) return 'renamed';
  return 'modified'; // M, C, T, U collapse to modified for v1
}

/**
 * Parse `git log --raw --numstat` output produced with PRETTY. Raw lines give
 * status + old/new paths; numstat lines give counts ("-" = binary); joined by
 * final path. Pure function — unit-tested against fixture text.
 */
export function parseGitLog(text: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const chunks = text.split(COMMIT_SENTINEL).filter((c) => c.trim().length > 0);
  for (const chunk of chunks) {
    const bodyStart = chunk.indexOf(BODY_SENTINEL);
    const bodyEnd = chunk.indexOf(ENDBODY_SENTINEL);
    if (bodyStart === -1 || bodyEnd === -1) continue;

    const head = chunk.slice(0, bodyStart);
    const body = chunk.slice(bodyStart + BODY_SENTINEL.length, bodyEnd).replace(/^\n/, '').trimEnd();
    const tail = chunk.slice(bodyEnd + ENDBODY_SENTINEL.length);

    const headLines = head.split('\n').filter((l) => l.length > 0);
    if (headLines.length < 2) continue;
    const [hash, parentsRaw, authoredAt, committedAt, author] = headLines[0].split('\t');
    const subject = headLines[1] ?? '';
    if (!hash) continue;

    const files = new Map<string, GitFileChange>();

    for (const line of tail.split('\n')) {
      if (line.startsWith(':')) {
        // raw line: ":100644 100644 abc def M\tpath" or "... R95\told\tnew"
        const afterModes = line.slice(1).split('\t');
        const meta = afterModes[0].trim().split(/\s+/);
        const letter = meta[meta.length - 1];
        const status = statusFromRaw(letter);
        const p1 = afterModes[1];
        const p2 = afterModes[2];
        const path = status === 'renamed' && p2 ? p2 : p1;
        if (!path) continue;
        const entry = files.get(path) ?? { path, status, additions: null, deletions: null, isBinary: false };
        entry.status = status;
        if (status === 'renamed' && p2) entry.oldPath = p1;
        files.set(path, entry);
      } else {
        // numstat line: "adds\tdels\tpath" ("-" for binary; renames use "{a => b}" or "old\tnew")
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [a, d] = parts;
        if (!/^(\d+|-)$/.test(a) || !/^(\d+|-)$/.test(d)) continue;
        const isBinary = a === '-' || d === '-';
        let path: string;
        let oldPath: string | undefined;
        if (parts.length >= 4 && parts[2] && parts[3]) {
          oldPath = parts[2];
          path = parts[3];
        } else {
          const expanded = expandRenamePath(parts[2]);
          path = expanded.newPath;
          if (expanded.oldPath !== expanded.newPath) oldPath = expanded.oldPath;
        }
        const entry = files.get(path) ?? {
          path,
          status: oldPath ? ('renamed' as const) : ('modified' as const),
          additions: null,
          deletions: null,
          isBinary: false,
        };
        entry.additions = isBinary ? null : Number(a);
        entry.deletions = isBinary ? null : Number(d);
        entry.isBinary = isBinary;
        if (oldPath && !entry.oldPath) entry.oldPath = oldPath;
        files.set(path, entry);
      }
    }

    commits.push({
      hash,
      parents: (parentsRaw ?? '').split(' ').filter(Boolean),
      authoredAt: authoredAt ?? '',
      committedAt: committedAt ?? '',
      author: author ?? '',
      subject,
      body,
      files: Array.from(files.values()),
    });
  }
  return commits;
}

/** Run git log for a repo; sinceIso limits the walk (incremental sync), while
 * allRefs makes a history-rewrite repair cover the same reachability domain as
 * its `rev-list --all` safety preflight. */
export async function logCommits(
  repo: string,
  sinceIso?: string,
  allRefs = false
): Promise<GitCommit[]> {
  // core.quotepath=false: default git quotes+octal-escapes non-ASCII paths
  // ("h\303\251llo.ts"), which would corrupt the index (review finding).
  const args = ['-C', repo, '-c', 'core.quotepath=false', 'log', '-M', '--raw', '--numstat', `--pretty=format:${PRETTY}`];
  if (allRefs) args.push('--all');
  if (sinceIso) args.push(`--since=${sinceIso}`);
  const { stdout } = await exec('git', args, { maxBuffer: MAX_GIT_BUFFER });
  return parseGitLog(stdout);
}

export interface WorktreeSummary {
  branch: string;
  staged: number;
  unstaged: number;
  untracked: number;
  topPaths: string[];
}

/** Parse `git status --porcelain=v1 -b` output. Pure — unit-tested. */
export function parseWorktreeStatus(text: string): WorktreeSummary {
  const lines = text.split('\n').filter((l) => l.length > 0);
  let branch = '(detached)';
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const topPaths: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = line.slice(3).split('...')[0].trim();
      continue;
    }
    const x = line[0];
    const y = line[1];
    const p = line.slice(3);
    if (x === '?' && y === '?') untracked++;
    else {
      if (x !== ' ') staged++;
      if (y !== ' ') unstaged++;
    }
    if (topPaths.length < 10) topPaths.push(p);
  }
  return { branch, staged, unstaged, untracked, topPaths };
}

export async function worktreeSummary(repo: string): Promise<WorktreeSummary> {
  const { stdout } = await exec('git', ['-C', repo, '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-b'], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseWorktreeStatus(stdout);
}

export async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

export async function commitExists(repo: string, hash: string): Promise<boolean> {
  try {
    await exec('git', ['-C', repo, 'cat-file', '-e', `${hash}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Every commit reachable from any local ref: branches, tags, remote-tracking
 * refs and any explicit safety refs. History-rewrite preflight must use this,
 * not the current-HEAD ingestion walk, or a retained secret branch can hide. */
export async function allReachableCommitHashes(repo: string): Promise<Set<string>> {
  const { stdout } = await exec('git', ['-C', repo, 'rev-list', '--all'], {
    maxBuffer: MAX_GIT_BUFFER,
  });
  return new Set(stdout.split(/\r?\n/).filter((hash) => HASH_LINE.test(hash)));
}

const HASH_LINE = /^[0-9a-f]{40}$/;

const PATCH_TOTAL_CAP = 200_000;
const PATCH_FILE_CAP = 40_000;

/**
 * Live patch hydration — bounded, never persisted. Returns per-file diff text
 * (binaries skipped by git itself with --no-textconv default + our cap note).
 */
export async function showPatch(repo: string, hash: string, paths?: string[]): Promise<string> {
  const args = ['-C', repo, 'show', hash, '--patch', '--no-color', '--format='];
  if (paths && paths.length > 0) args.push('--', ...paths);
  const { stdout } = await exec('git', args, { maxBuffer: MAX_GIT_BUFFER });
  if (stdout.length <= PATCH_TOTAL_CAP) return stdout;
  // Per-file trim: keep each file's diff up to the cap, then hard-stop at total.
  const sections = stdout.split(/^diff --git /m);
  const out: string[] = [];
  let total = 0;
  for (const s of sections) {
    if (!s.trim()) continue;
    const piece = 'diff --git ' + s.slice(0, PATCH_FILE_CAP);
    if (total + piece.length > PATCH_TOTAL_CAP) {
      out.push(`\n[... patch truncated at ${PATCH_TOTAL_CAP} bytes — narrow with paths ...]`);
      break;
    }
    out.push(piece);
    total += piece.length;
  }
  return out.join('\n');
}
