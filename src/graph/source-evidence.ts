// Call-scoped source evidence. No parser imports, persisted text or global cache.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execBounded } from '../git/repo.js';
import { owningRegisteredRepo } from './contracts.js';
import { canonicalPhysicalPath } from './roots.js';
import { isExcluded } from './walk.js';

export type SourceMode = 'typescript' | 'utf8';
export type SourceReason = 'root' | 'git' | 'non-git' | 'conflict' | 'excluded'
  | 'untracked' | 'missing' | 'path' | 'read' | 'race' | 'size' | 'budget';
export type SourceRead = { state: 'verified'; hash: string }
  | { state: 'removed' | 'unknown'; reason: SourceReason };
export interface SourceCensus {
  state: 'ready' | 'unknown';
  reason?: SourceReason;
  files: ReadonlySet<string>;
  conflicts: ReadonlySet<string>;
}
export const SOURCE_FILE_BYTES = 16 * 1024 * 1024;
export const SOURCE_TOTAL_BYTES = 128 * 1024 * 1024;
export const SOURCE_CONCURRENCY = 4;

export function validSourceHash(hash: string | null): hash is string {
  return hash !== null && /^[0-9a-f]{64}$/.test(hash);
}

export function decodeSource(bytes: Buffer, mode: SourceMode): string {
  if (mode === 'utf8') return bytes.toString('utf8');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(0, bytes.length & ~1));
    swapped.swap16();
    return swapped.toString('utf16le', 2);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2);
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return bytes.toString('utf8', offset);
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function hasGitMarker(root: string): boolean {
  for (let dir = root;; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

async function census(repo: string, repos: readonly string[], excludes: readonly string[]): Promise<SourceCensus> {
  const files = new Set<string>();
  const conflicts = new Set<string>();
  try {
    if (!fs.statSync(repo).isDirectory()) return { state: 'unknown', reason: 'root', files, conflicts };
  } catch { return { state: 'unknown', reason: 'root', files, conflicts }; }
  let top: string;
  try {
    const out = await execBounded('git', ['-C', repo, 'rev-parse', '--show-toplevel']);
    top = canonicalPhysicalPath(out.stdout.replace(/\r?\n$/, ''), repo);
  } catch (error) {
    // Only a positively identified ordinary directory gets the non-Git label.
    const ordinary = !hasGitMarker(repo) && errno(error) !== 'ENOENT'
      && error instanceof Error && /not a git repository/i.test(error.message);
    return { state: 'unknown', reason: ordinary ? 'non-git' : 'git', files, conflicts };
  }
  try {
    const out = await execBounded('git', ['-C', top, 'ls-files', '--stage', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const entry of out.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) [0-9a-f]+ ([0-3])\t([\s\S]+)$/.exec(entry);
      if (match === null) return { state: 'unknown', reason: 'git', files, conflicts };
      const lexical = path.resolve(top, match[3]);
      // Excludes precede physical resolution and all source-content reads.
      if (isExcluded(lexical, excludes)) continue;
      const physical = canonicalPhysicalPath(lexical, top);
      if (owningRegisteredRepo(physical, repos) !== repo || isExcluded(physical, excludes)) continue;
      // Symlink entries are never treated as tracked content at their targets.
      if (match[1] === '120000' || lexical !== physical) continue;
      if (match[2] !== '0') conflicts.add(physical);
      if (match[1] === '100644' || match[1] === '100755') files.add(physical);
    }
    return { state: 'ready', files, conflicts };
  } catch { return { state: 'unknown', reason: 'git', files, conflicts }; }
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Limits are an internal test seam; production uses the fixed status budget. */
export class SourceEvidence {
  private readonly censuses = new Map<string, Promise<SourceCensus>>();
  private readonly reads = new Map<string, Promise<SourceRead>>();
  private active = 0;
  private used = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    readonly repos: readonly string[],
    readonly excludes: readonly string[] = [],
    private readonly limits = { file: SOURCE_FILE_BYTES, total: SOURCE_TOTAL_BYTES },
  ) {}

  census(repo: string): Promise<SourceCensus> {
    let pending = this.censuses.get(repo);
    if (pending === undefined) {
      pending = census(repo, this.repos, this.excludes);
      this.censuses.set(repo, pending);
    }
    return pending;
  }

  read(file: string, mode: SourceMode): Promise<SourceRead> {
    const key = `${file}\0${mode}`;
    let pending = this.reads.get(key);
    if (pending === undefined) {
      pending = this.readOnce(file, mode);
      this.reads.set(key, pending);
    }
    return pending;
  }

  private async readOnce(file: string, mode: SourceMode): Promise<SourceRead> {
    const repo = owningRegisteredRepo(file, this.repos);
    if (repo === null) return { state: 'unknown', reason: 'root' };
    if (isExcluded(file, this.excludes)) return { state: 'unknown', reason: 'excluded' };
    const tracked = await this.census(repo);
    if (tracked.state !== 'ready') return { state: 'unknown', reason: tracked.reason ?? 'git' };
    if (tracked.conflicts.has(file)) return { state: 'unknown', reason: 'conflict' };
    if (!tracked.files.has(file)) return { state: 'removed', reason: 'untracked' };
    if (this.active >= SOURCE_CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    let handle: fs.promises.FileHandle | undefined;
    try {
      if (await fs.promises.realpath(file) !== file) return { state: 'unknown', reason: 'path' };
      const before = await fs.promises.lstat(file, { bigint: true });
      if (!before.isFile()) return { state: 'unknown', reason: 'path' };
      if (before.size > BigInt(this.limits.file)) return { state: 'unknown', reason: 'size' };
      const size = Number(before.size);
      if (this.used + size > this.limits.total) return { state: 'unknown', reason: 'budget' };
      this.used += size;
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      if (!sameFile(before, await handle.stat({ bigint: true }))) return { state: 'unknown', reason: 'race' };
      // One sentinel byte detects growth without allocating an unbounded readFile buffer.
      const bytes = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const atPath = await fs.promises.lstat(file, { bigint: true });
      if (offset !== size || !sameFile(before, after) || !sameFile(after, atPath)
        || await fs.promises.realpath(file) !== file) return { state: 'unknown', reason: 'race' };
      const text = decodeSource(bytes.subarray(0, size), mode);
      return { state: 'verified', hash: crypto.createHash('sha256').update(text).digest('hex') };
    } catch (error) {
      return errno(error) === 'ENOENT'
        ? { state: 'removed', reason: 'missing' } : { state: 'unknown', reason: 'read' };
    } finally {
      try { await handle?.close().catch(() => undefined); }
      finally {
        const next = this.waiting.shift();
        if (next === undefined) this.active--;
        else next();
      }
    }
  }
}
