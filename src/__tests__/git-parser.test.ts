/** Pure-parser tests for the git evidence layer — no repo, no DB. */
import { describe, expect, it } from 'vitest';
import { expandRenamePath, parseGitLog, parseWorktreeStatus } from '../git/repo.js';

const SAMPLE_LOG = [
  '@@MAI-COMMIT@@',
  'aaa111\tp1 p2\t2026-07-01T10:00:00-04:00\t2026-07-01T10:05:00-04:00\tMatt Jones',
  'feat(x): add thing',
  '@@MAI-BODY@@',
  'Longer body here.',
  '',
  'Co-Authored-By: Claude <n@a.com>@@MAI-ENDBODY@@',
  ':100644 100644 abc def M\tsrc/a.ts',
  ':000000 100644 000 abc A\tsrc/new.ts',
  ':100644 100644 abc def R95\tsrc/old-name.ts\tsrc/new-name.ts',
  '3\t1\tsrc/a.ts',
  '10\t0\tsrc/new.ts',
  '1\t1\tsrc/{old-name.ts => new-name.ts}',
  '-\t-\tassets/logo.png',
  '@@MAI-COMMIT@@',
  'bbb222\t\t2026-07-02T09:00:00-04:00\t2026-07-02T09:00:00-04:00\tMatt Jones',
  'chore: root commit',
  '@@MAI-BODY@@',
  '@@MAI-ENDBODY@@',
  ':000000 100644 000 abc A\tREADME.md',
  '1\t0\tREADME.md',
].join('\n');

describe('parseGitLog', () => {
  it('parses commits, parents, dates, body, and joined file changes', () => {
    const commits = parseGitLog(SAMPLE_LOG);
    expect(commits).toHaveLength(2);

    const c = commits[0];
    expect(c.hash).toBe('aaa111');
    expect(c.parents).toEqual(['p1', 'p2']); // merge commit
    expect(c.subject).toBe('feat(x): add thing');
    expect(c.body).toContain('Co-Authored-By');
    expect(c.committedAt).toBe('2026-07-01T10:05:00-04:00');

    const byPath = new Map(c.files.map((f) => [f.path, f]));
    expect(byPath.get('src/a.ts')).toMatchObject({ status: 'modified', additions: 3, deletions: 1 });
    expect(byPath.get('src/new.ts')).toMatchObject({ status: 'added', additions: 10 });
    expect(byPath.get('src/new-name.ts')).toMatchObject({
      status: 'renamed',
      oldPath: 'src/old-name.ts',
      additions: 1,
    });
    expect(byPath.get('assets/logo.png')).toMatchObject({ isBinary: true, additions: null });

    expect(commits[1].parents).toEqual([]); // root commit
    expect(commits[1].body).toBe('');
  });
});

describe('expandRenamePath', () => {
  it('expands brace syntax and passes plain paths through', () => {
    expect(expandRenamePath('src/{old => new}/x.ts')).toEqual({
      oldPath: 'src/old/x.ts',
      newPath: 'src/new/x.ts',
    });
    expect(expandRenamePath('plain/path.ts')).toEqual({
      oldPath: 'plain/path.ts',
      newPath: 'plain/path.ts',
    });
  });

  it('handles the brace-less full rename form (no common prefix/suffix)', () => {
    expect(expandRenamePath('a.ts => b.ts')).toEqual({ oldPath: 'a.ts', newPath: 'b.ts' });
  });
});

describe('parseGitLog — brace-less rename', () => {
  it('does not produce a phantom modified row for "old => new" numstat lines', () => {
    const log = [
      '@@MAI-COMMIT@@',
      'ccc333\tp1\t2026-07-03T09:00:00-04:00\t2026-07-03T09:00:00-04:00\tMatt Jones',
      'refactor: rename a to b',
      '@@MAI-BODY@@',
      '@@MAI-ENDBODY@@',
      ':100644 100644 abc def R100\ta.ts\tb.ts',
      '0\t0\ta.ts => b.ts',
    ].join('\n');
    const commits = parseGitLog(log);
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toHaveLength(1);
    expect(commits[0].files[0]).toMatchObject({
      path: 'b.ts',
      status: 'renamed',
      oldPath: 'a.ts',
      additions: 0,
      deletions: 0,
    });
  });
});

describe('parseWorktreeStatus', () => {
  it('summarizes branch + staged/unstaged/untracked', () => {
    const s = parseWorktreeStatus(
      ['## feat/x...origin/feat/x', 'M  src/a.ts', ' M src/b.ts', 'MM src/c.ts', '?? scratch.txt'].join('\n')
    );
    expect(s.branch).toBe('feat/x');
    expect(s.staged).toBe(2); // 'M ' + 'MM'
    expect(s.unstaged).toBe(2); // ' M' + 'MM'
    expect(s.untracked).toBe(1);
    expect(s.topPaths).toContain('src/b.ts');
  });
});
