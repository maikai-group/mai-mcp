// mai-graph behavioral extractor (spec §3.6) — NOT a parser. Computes
// co_changed_with edges (confidence 'behavioral', weight = co-commit count)
// from git history: files changed in the same commit co-change in practice —
// the relationship static analysis cannot see. Fully retroactive to the first
// commit. Emits NO nodes: edges reference existing file/script nodes by
// qualified name and the engine drops refs to files that no longer exist.
//
// Session enrichment (spec's source b) is DEFERRED: as-built capture stores no
// per-session file lists (all 22 code_sessions rows had empty metadata,
// verified 2026-06-12). When ingest records file lists, add that source here.
//
// Noise controls (authoring decisions 2026-06-12, tune on evidence):
// commits touching >50 files are skipped; history capped at 2,000 commits per
// repo; pairs below weight 2 are dropped.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { owningRegisteredRepo, serviceIdentity, sourceQNameForPath } from '../contracts.js';
import { canonicalGitTopLevel, canonicalPhysicalPath, canonicalRegisteredRoots } from '../roots.js';
import type { ExtractedEdge, ExtractorOutput, GraphExtractor, NodeRef } from '../types.js';

const exec = promisify(execFile);

// Every extension whose extractor emits FILE nodes — an edge endpoint that has
// no node drops at the engine, so listing an ext here without a file-node
// producer is inert, but OMITTING one silently blanks co-change for that whole
// language (plan 35 execution amendment A7: .kt/.swift/.cpp-family/.php were
// missing, so JUCE/Android/iOS/WP repos had ZERO co_changed_with edges).
// .kts stays out on purpose: structure-only, no file nodes (spec A6/§3).
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.bash',
  '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh',
  '.php', '.kt', '.swift',
  '.go', '.rs', '.java', '.cs', // plan 36: tier-2 file-node producers (A7)
]);
const MAX_FILES_PER_COMMIT = 50;
const MAX_COMMITS = 2000;
const MIN_WEIGHT = 2;

/** Parse `git log --name-only --pretty=format:%H` output into per-commit
 * file-path lists (repo-relative). Commit hash lines are 40-hex; blocks are
 * blank-line separated. Exported for tests. */
export function parseGitNameOnly(stdout: string): string[][] {
  const commits: string[][] = [];
  let current: string[] | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (/^[0-9a-f]{40}$/.test(line)) {
      if (current) commits.push(current);
      current = [];
    } else if (line && current) {
      current.push(line);
    }
  }
  if (current) commits.push(current);
  return commits;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Count unordered source-file pairs across commits, applying the noise
 * controls. Keys are canonical (sorted) `a b`. Exported for tests. */
export function coChangePairs(commits: string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const files of commits) {
    const sources = [...new Set(files.filter((f) => SOURCE_EXT.has(path.extname(f))))];
    if (sources.length < 2 || sources.length > MAX_FILES_PER_COMMIT) continue;
    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const k = pairKey(sources[i], sources[j]);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function refFor(repo: string, serviceId: string, relPath: string): NodeRef {
  const ext = path.extname(relPath);
  const legacy = `${path.basename(repo)}/${relPath}`;
  return {
    kind: ext === '.sh' || ext === '.bash' ? 'script' : 'file',
    qualifiedName: sourceQNameForPath(serviceId, legacy, ext),
  };
}

export const behavioralExtractor: GraphExtractor = {
  name: 'behavioral',
  vocabulary: { kinds: [], relations: ['co_changed_with'] },
  async extract({ repoPaths }): Promise<ExtractorOutput> {
    const edges: ExtractedEdge[] = [];
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    for (const repo of resolvedRepos) {
      let stdout: string;
      try {
        const gitTopLevel = canonicalGitTopLevel(repo);
        const r = await exec(
          'git',
          // core.quotePath=false: without it git quotes and octal-escapes any
          // non-ASCII path, `path.extname('"caf\303\251.ts"')` is `.ts"`, and
          // the file silently drops out of every co-change pair (plan 46
          // review finding 090f40de, sibling site).
          ['-C', gitTopLevel, '-c', 'core.quotePath=false', 'log', '--name-only', '--no-renames', `-n`, String(MAX_COMMITS), '--pretty=format:%H'],
          { maxBuffer: 256 * 1024 * 1024 }
        );
        stdout = r.stdout;
        const identity = serviceIdentity(repo);
        const ownedCommits = parseGitNameOnly(stdout).map((files) => files.flatMap((gitRelativePath) => {
          const absolute = canonicalPhysicalPath(path.resolve(gitTopLevel, gitRelativePath), gitTopLevel);
          if (owningRegisteredRepo(absolute, resolvedRepos) !== repo) return [];
          return [path.relative(repo, absolute).split(path.sep).join('/')];
        }));
        for (const [key, count] of coChangePairs(ownedCommits)) {
          if (count < MIN_WEIGHT) continue;
          const [a, b] = key.split(' ');
          edges.push({
            from: refFor(repo, identity.id, a),
            to: refFor(repo, identity.id, b),
            relation: 'co_changed_with',
            confidence: 'behavioral',
            weight: count,
            metadata: { source: 'git', commits: count },
          });
        }
      } catch {
        continue; // not a git repo / no commits — behavioral simply has nothing
      }
    }
    return { nodes: [], edges };
  },
};
