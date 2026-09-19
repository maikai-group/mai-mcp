// Repo file enumeration. listRepoFiles is the canonical entry (git-tracked +
// exclude-aware, decision c6c84cbf); walkFiles survives as the non-git fallback.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalPhysicalPath } from './roots.js';
import { owningRegisteredRepo } from './contracts.js';

const SKIP_DIRS = new Set([
  'node_modules', 'build', 'dist', 'coverage', 'graphify-out',
  // UE build output — generated/compiled, never source of truth. Only reachable
  // via the non-git fallback (git repos gitignore these), belt-and-suspenders.
  'Intermediate', 'Binaries', 'Saved', 'DerivedDataCache',
  // Xcode build output — fs-walk fallback only (git repos gitignore it).
  'DerivedData',
]);

export function walkFiles(dir: string, extensions: ReadonlySet<string>, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkFiles(full, extensions, acc);
    } else if (extensions.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/** True when absFile sits at or under any exclude prefix (absolute paths). */
export function isExcluded(absFile: string, excludes: readonly string[]): boolean {
  return excludes.some((ex) => absFile === ex || absFile.startsWith(ex + path.sep));
}

/**
 * Canonical repo file enumeration (decision c6c84cbf): git-tracked files when
 * the dir is a git repo (nested repos, untracked junk, and .gitignore'd files
 * excluded by definition — consistent with the git-diff incremental path),
 * fs-walk fallback otherwise. Extension-filtered, then exclude-filtered.
 */
export function listRepoFiles(
  dir: string,
  extensions: ReadonlySet<string>,
  excludes: readonly string[] = []
): string[] {
  const root = path.resolve(dir);
  let candidates: string[] | null = null;
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], // inspect expected non-Git failure without printing it
    });
    candidates = out.toString('utf8').split('\0').filter(Boolean).map((rel) => path.join(root, rel));
  } catch (error) {
    let marker = false;
    for (let parent = root;; parent = path.dirname(parent)) {
      if (fs.existsSync(path.join(parent, '.git'))) { marker = true; break; }
      if (path.dirname(parent) === parent) break;
    }
    // Keep the existing ordinary-directory walk, but never reinterpret a broken
    // Git census as permission to index untracked files or delete existing rows.
    if (marker || !(error instanceof Error) || !/not a git repository/i.test(error.message)) {
      throw new Error('Graph source enumeration failed; registered Git source is unavailable.');
    }
    candidates = null;
  }
  const files = candidates ?? walkFiles(root, extensions);
  return files.filter((f) => extensions.has(path.extname(f)) && !isExcluded(path.resolve(f), excludes));
}

/** Enumerate only files physically owned by this registered root. */
export function listOwnedRepoFiles(
  repoRoot: string,
  allRegisteredRoots: readonly string[],
  extensions: ReadonlySet<string>,
  excludes: readonly string[] = [],
): string[] {
  if (!path.isAbsolute(repoRoot) || allRegisteredRoots.some((root) => !path.isAbsolute(root))) {
    throw new Error('Owned repo enumeration requires absolute registered roots');
  }
  const canonicalRoot = canonicalPhysicalPath(repoRoot, repoRoot);
  const roots = allRegisteredRoots.map((root) => canonicalPhysicalPath(root, root));
  const canonicalExcludes = excludes.map((exclude) => canonicalPhysicalPath(exclude, canonicalRoot));
  return listRepoFiles(canonicalRoot, extensions, canonicalExcludes)
    .map((candidate) => canonicalPhysicalPath(candidate, canonicalRoot))
    .filter((candidate) => owningRegisteredRepo(candidate, roots) === canonicalRoot);
}
