import path from 'node:path';
import { execBounded } from '../git/repo.js';
import { owningRegisteredRepo } from './contracts.js';
import { canonicalPhysicalPath } from './roots.js';
import { SourceEvidence } from './source-evidence.js';
import { isExcluded } from './walk.js';

export type WatchCensus = ReadonlyMap<string, ReadonlySet<string>>;
interface Hints { all: boolean; git: boolean; paths: Set<string> }
const MAX_PENDING_PATHS = 1_024;
export const inside = (file: string, root: string): boolean => file === root || file.startsWith(root + path.sep);

export async function readWatchCensus(repos: readonly string[], excludes: readonly string[]): Promise<WatchCensus> {
  const source = new SourceEvidence(repos, excludes);
  const result = new Map<string, ReadonlySet<string>>();
  for (const repo of repos) {
    const census = await source.census(repo);
    if (census.state !== 'ready' || census.conflicts.size > 0) throw new Error('Graph watch source census unavailable.');
    result.set(repo, census.files);
  }
  return result;
}

/** Separate git-dir/common-dir calls preserve path whitespace and linked worktrees. */
export async function graphGitDirectories(repo: string): Promise<string[]> {
  const result = new Set<string>();
  for (const flag of ['--git-dir', '--git-common-dir']) {
    const { stdout } = await execBounded('git', ['-C', repo, 'rev-parse', '--path-format=absolute', flag]);
    result.add(canonicalPhysicalPath(stdout.replace(/\r?\n$/, ''), repo));
  }
  return [...result];
}

export class WatchChanges {
  private previous: WatchCensus = new Map();
  private pending = new Map<string, Hints>();
  constructor(
    private readonly repos: readonly string[],
    private readonly excludes: readonly string[],
    private readonly read: () => Promise<WatchCensus> = () => readWatchCensus(repos, excludes),
  ) {}

  async prime(): Promise<void> { this.previous = await this.read(); }

  private hints(root: string): Hints {
    let hints = this.pending.get(root);
    if (!hints) { hints = { all: false, git: false, paths: new Set() }; this.pending.set(root, hints); }
    return hints;
  }

  git(root: string): boolean {
    if (!this.repos.includes(root)) return false;
    this.hints(root).git = true;
    return true;
  }

  source(watchedRoot: string, filename: string | null): boolean {
    if (filename === null) {
      let accepted = false;
      for (const root of this.repos.filter(root => inside(root, watchedRoot) && !isExcluded(root, this.excludes))) {
        const hints = this.hints(root); hints.all = true; hints.paths.clear(); accepted = true;
      }
      return accepted;
    }
    if (path.isAbsolute(filename)) return false;
    const lexical = path.resolve(watchedRoot, filename);
    if (!inside(lexical, watchedRoot) || isExcluded(lexical, this.excludes)) return false;
    let physical: string;
    try { physical = canonicalPhysicalPath(lexical, watchedRoot); } catch { return false; }
    if (physical !== lexical || !inside(physical, watchedRoot) || isExcluded(physical, this.excludes)) return false;
    const root = owningRegisteredRepo(physical, this.repos);
    if (root === null) return false;
    for (const affected of this.repos.filter(candidate => candidate === root || inside(candidate, physical))) {
      const hints = this.hints(affected);
      if (inside(affected, physical)) { hints.all = true; hints.paths.clear(); }
      if (!hints.all) {
        hints.paths.add(physical);
        if (hints.paths.size > MAX_PENDING_PATHS) { hints.all = true; hints.paths.clear(); }
      }
    }
    return true;
  }

  async check(): Promise<boolean> {
    const batch = this.pending;
    this.pending = new Map(); // New events belong to the next batch, even during census.
    let current: WatchCensus;
    try { current = await this.read(); }
    catch {
      for (const [root, old] of batch) {
        const hints = this.hints(root); hints.all = true; hints.git ||= old.git; hints.paths.clear();
      }
      throw new Error('Graph watch source census unavailable.');
    }
    // Membership observed by this census must not be swallowed when its Git
    // notification arrives after the batch snapshot. Content hints remain queued.
    let changed = this.repos.some(root => {
      const before = this.previous.get(root) ?? new Set<string>();
      const after = current.get(root) ?? new Set<string>();
      return before.size !== after.size || [...before].some(file => !after.has(file));
    });
    for (const [root, hints] of batch) {
      const before = this.previous.get(root) ?? new Set<string>();
      const after = current.get(root) ?? new Set<string>();
      if (hints.all) changed = true;
      const matches = (files: ReadonlySet<string>): boolean => {
        for (const file of files) {
          for (let parent = file; inside(parent, root); parent = path.dirname(parent)) {
            if (hints.paths.has(parent)) return true;
            if (parent === root) break;
          }
        }
        return false;
      };
      if (matches(before) || matches(after)) changed = true;
    }
    this.previous = current;
    return changed;
  }
}
