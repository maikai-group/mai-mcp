// listRepoFiles: tracked-only enumeration with fs-walk fallback (decision
// c6c84cbf). Fixtures are throwaway git repos under os.tmpdir() — outside any
// enclosing repo, so the non-git test genuinely exercises the fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isExcluded, listOwnedRepoFiles, listRepoFiles } from '../graph/walk.js';
import { canonicalPhysicalPath } from '../graph/roots.js';

const TS_EXT = new Set(['.ts']);
const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
};

describe('listRepoFiles', () => {
  let repo: string;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-walk-'));
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    fs.mkdirSync(path.join(repo, 'dead'));
    fs.writeFileSync(path.join(repo, 'dead', 'legacy.ts'), 'export const d = 1;\n');
    git(repo, 'add', 'a.ts', 'dead/legacy.ts');
    git(repo, 'commit', '-qm', 'fixture');
    fs.writeFileSync(path.join(repo, 'untracked.ts'), 'export const u = 1;\n'); // never committed
    const nested = path.join(repo, 'sub');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q');
    fs.writeFileSync(path.join(nested, 'inner.ts'), 'export const i = 1;\n');
    git(nested, 'add', 'inner.ts');
    git(nested, 'commit', '-qm', 'nested fixture');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('returns tracked files only — untracked and nested-repo files excluded', () => {
    const files = listRepoFiles(repo, TS_EXT);
    expect(files).toContain(path.join(repo, 'a.ts'));
    expect(files).toContain(path.join(repo, 'dead', 'legacy.ts'));
    expect(files).not.toContain(path.join(repo, 'untracked.ts'));
    expect(files.some((f) => f.includes(`${path.sep}sub${path.sep}`))).toBe(false);
  });

  it('a nested repo enumerated directly sees its own tracked files', () => {
    expect(listRepoFiles(path.join(repo, 'sub'), TS_EXT)).toEqual([path.join(repo, 'sub', 'inner.ts')]);
  });

  it('applies exclude prefixes', () => {
    const files = listRepoFiles(repo, TS_EXT, [path.join(repo, 'dead')]);
    expect(files).toContain(path.join(repo, 'a.ts'));
    expect(files.some((f) => f.includes(`${path.sep}dead${path.sep}`))).toBe(false);
  });

  it('falls back to fs walk for non-git dirs (untracked concept does not apply)', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-walk-plain-'));
    try {
      fs.writeFileSync(path.join(plain, 'x.ts'), 'export const x = 1;\n');
      expect(listRepoFiles(plain, TS_EXT)).toEqual([path.join(plain, 'x.ts')]);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('isExcluded matches prefix and exact, not siblings', () => {
    expect(isExcluded('/r/pwa/app.ts', ['/r/pwa'])).toBe(true);
    expect(isExcluded('/r/pwa', ['/r/pwa'])).toBe(true);
    expect(isExcluded('/r/pwa-two/app.ts', ['/r/pwa'])).toBe(false);
  });

  it('partitions a parent-visible worktree by the longest registered physical owner', () => {
    const umbrella = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-walk-owned-'));
    try {
      git(umbrella, 'init', '-q');
      const child = path.join(umbrella, 'services', 'api');
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(umbrella, 'parent.ts'), 'export const parent = 1;\n');
      fs.writeFileSync(path.join(child, 'child.ts'), 'export const child = 1;\n');
      git(umbrella, 'add', 'parent.ts', 'services/api/child.ts');
      git(umbrella, 'commit', '-qm', 'owned fixture');
      const parentRoot = canonicalPhysicalPath(umbrella, umbrella);
      const childRoot = canonicalPhysicalPath(child, umbrella);
      const roots = [parentRoot, childRoot];
      expect(listOwnedRepoFiles(parentRoot, roots, TS_EXT)).toEqual([path.join(parentRoot, 'parent.ts')]);
      expect(listOwnedRepoFiles(childRoot, roots, TS_EXT)).toEqual([path.join(childRoot, 'child.ts')]);
      expect(listOwnedRepoFiles(parentRoot, [...roots].reverse(), TS_EXT)).toEqual([path.join(parentRoot, 'parent.ts')]);
      expect(() => listOwnedRepoFiles('relative', roots, TS_EXT)).toThrow('absolute registered roots');
    } finally {
      fs.rmSync(umbrella, { recursive: true, force: true });
    }
  });
});
