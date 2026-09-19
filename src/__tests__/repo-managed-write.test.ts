/** Plan 15 Task 3: the 05ec915d contained writer — secure missing creation,
 * mode preservation, unchanged no-write, pre-commit race detection via the
 * injected beforeCommit seam, temp cleanup, and the recorded projection
 * default (atomicReplace follows symlink targets; the contained writer never
 * does). The structural gate pins the commit section's non-yielding shape in
 * source, because no runtime probe can prove the absence of an await. */
import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRepoManagedDestination,
  prepareRepoManagedDestination,
  updateRepoManagedFile,
  RepoManagedWriteError,
} from '../repo-managed-write.js';
import { atomicReplace } from '../rules-render.js';

function tmp(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('updateRepoManagedFile', () => {
  it('creates a missing file securely, one parent component at a time', async () => {
    const repo = tmp('mai-rmw-create-');
    const status = await updateRepoManagedFile(repo, path.join('.claude', 'settings.json'), () => '{"a":1}\n');
    expect(status).toBe('created');
    expect(readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{"a":1}\n');
    expect(lstatSync(path.join(repo, '.claude')).isDirectory()).toBe(true);
  });

  it('updates an existing regular file and preserves its mode', async () => {
    const repo = tmp('mai-rmw-mode-');
    const file = path.join(repo, 'CLAUDE.md');
    writeFileSync(file, 'before\n');
    chmodSync(file, 0o640);
    const status = await updateRepoManagedFile(repo, 'CLAUDE.md', (current) => `${current}after\n`);
    expect(status).toBe('updated');
    expect(readFileSync(file, 'utf8')).toBe('before\nafter\n');
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it('a null or identical transform writes nothing', async () => {
    const repo = tmp('mai-rmw-null-');
    const file = path.join(repo, 'AGENTS.md');
    writeFileSync(file, 'stable\n');
    const before = statSync(file);
    expect(await updateRepoManagedFile(repo, 'AGENTS.md', () => null)).toBe('unchanged');
    expect(await updateRepoManagedFile(repo, 'AGENTS.md', (c) => c)).toBe('unchanged');
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it('detects a target swapped in the beforeCommit seam and leaves the victim unchanged', async () => {
    const repo = tmp('mai-rmw-race-');
    const victimDir = tmp('mai-rmw-victim-');
    const victim = path.join(victimDir, 'victim.md');
    writeFileSync(victim, 'victim untouched\n');
    const file = path.join(repo, 'CLAUDE.md');
    writeFileSync(file, 'original\n');

    await expect(
      updateRepoManagedFile(
        repo,
        'CLAUDE.md',
        () => 'replacement\n',
        {
          beforeCommit: () => {
            // Ordinary concurrent change: same-path rewrite moves the inode.
            writeFileSync(`${file}.swap`, 'concurrent\n');
            renameOver(`${file}.swap`, file);
          },
        }
      )
    ).rejects.toThrow(RepoManagedWriteError);
    expect(readFileSync(file, 'utf8')).toBe('concurrent\n');
    expect(readFileSync(victim, 'utf8')).toBe('victim untouched\n');
    expect(readdirSync(repo).filter((n) => n.includes('.mai-')).length).toBe(0);
  });

  it('detects a target turned into an outside symlink in beforeCommit', async () => {
    const repo = tmp('mai-rmw-symswap-');
    const victimDir = tmp('mai-rmw-victim2-');
    const victim = path.join(victimDir, 'victim.md');
    writeFileSync(victim, 'victim untouched\n');
    const file = path.join(repo, 'CLAUDE.md');
    writeFileSync(file, 'original\n');

    await expect(
      updateRepoManagedFile(
        repo,
        'CLAUDE.md',
        () => 'replacement\n',
        {
          beforeCommit: () => {
            renameOver(file, `${file}.aside`);
            symlinkSync(victim, file);
          },
        }
      )
    ).rejects.toThrow(RepoManagedWriteError);
    expect(readFileSync(victim, 'utf8')).toBe('victim untouched\n');
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('detects a parent swapped to an outside symlink in beforeCommit', async () => {
    const repo = tmp('mai-rmw-parentswap-');
    const victimDir = tmp('mai-rmw-victim3-');
    writeFileSync(path.join(victimDir, 'settings.json'), 'victim untouched\n');
    mkdirSync(path.join(repo, '.claude'));
    writeFileSync(path.join(repo, '.claude', 'settings.json'), 'original\n');

    await expect(
      updateRepoManagedFile(
        repo,
        path.join('.claude', 'settings.json'),
        () => 'replacement\n',
        {
          beforeCommit: () => {
            renameOver(path.join(repo, '.claude'), path.join(repo, '.claude-aside'));
            symlinkSync(victimDir, path.join(repo, '.claude'));
          },
        }
      )
    ).rejects.toThrow(RepoManagedWriteError);
    expect(readFileSync(path.join(victimDir, 'settings.json'), 'utf8')).toBe('victim untouched\n');
  });

  it('rejects a pre-existing symlinked target or parent before any write', async () => {
    const repo = tmp('mai-rmw-presym-');
    const victimDir = tmp('mai-rmw-victim4-');
    const victim = path.join(victimDir, 'file.md');
    writeFileSync(victim, 'victim untouched\n');
    symlinkSync(victim, path.join(repo, 'CLAUDE.md'));
    await expect(
      updateRepoManagedFile(repo, 'CLAUDE.md', () => 'x')
    ).rejects.toThrow(RepoManagedWriteError);
    expect(readFileSync(victim, 'utf8')).toBe('victim untouched\n');

    symlinkSync(victimDir, path.join(repo, '.codex'));
    await expect(
      updateRepoManagedFile(repo, path.join('.codex', 'config.toml'), () => 'x')
    ).rejects.toThrow(RepoManagedWriteError);
    expect(readdirSync(victimDir)).toEqual(['file.md']);
  });

  it('cleans its random temp on failure and leaves no droppings on success', async () => {
    const repo = tmp('mai-rmw-temp-');
    writeFileSync(path.join(repo, 'CLAUDE.md'), 'original\n');
    await expect(
      updateRepoManagedFile(repo, 'CLAUDE.md', () => 'next\n', {
        beforeCommit: () => {
          writeFileSync(path.join(repo, 'CLAUDE.md'), 'moved on\n');
        },
      })
    ).rejects.toThrow(RepoManagedWriteError);
    expect(readdirSync(repo).filter((n) => n.includes('.tmp')).length).toBe(0);

    await updateRepoManagedFile(repo, 'CLAUDE.md', () => 'clean write\n');
    expect(readdirSync(repo).sort()).toEqual(['CLAUDE.md']);
  });

  it('structural gate: the commit section is synchronous after beforeCommit', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/repo-managed-write.ts', import.meta.url)),
      'utf8'
    );
    const start = source.indexOf('await testHooks.beforeCommit?.();');
    const end = source.indexOf('return snapshot.missing');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const commitSection = source.slice(start + 'await testHooks.beforeCommit?.();'.length, end);
    expect(commitSection).not.toMatch(/\bawait\b/);
    expect(commitSection).not.toMatch(/testHooks/);
    expect(commitSection).not.toMatch(/spawn|execFile|exec\(/);
    expect(commitSection).not.toMatch(/setTimeout|setImmediate|nextTick/);
  });
});

describe('recorded projection default (plan 27) stays intact', () => {
  it('atomicReplace follows an existing symlink target; the contained writer rejects it', async () => {
    const repo = tmp('mai-rmw-projection-');
    const targetDir = tmp('mai-rmw-projection-target-');
    const real = path.join(targetDir, 'real.md');
    writeFileSync(real, 'projected original\n');
    const link = path.join(repo, 'CLAUDE.md');
    symlinkSync(real, link);

    // Projection policy: the symlink is followed, the TARGET gets the bytes,
    // and the link survives (Plan 27 decision 81a6977f).
    await atomicReplace(link, 'projected replacement\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(readFileSync(real, 'utf8')).toBe('projected replacement\n');

    // Contained policy: the same shape is a hard reject.
    await expect(
      updateRepoManagedFile(repo, 'CLAUDE.md', () => 'contained replacement\n')
    ).rejects.toThrow(RepoManagedWriteError);
    expect(readFileSync(real, 'utf8')).toBe('projected replacement\n');
  });
});

describe('assert/prepare split', () => {
  it('assertion never creates; preparation creates parents only', () => {
    const repo = tmp('mai-rmw-split-');
    assertRepoManagedDestination(repo, path.join('.agents', 'skills', 'x'));
    expect(existsSync(path.join(repo, '.agents'))).toBe(false);
    prepareRepoManagedDestination(repo, path.join('.agents', 'skills', 'x'));
    expect(lstatSync(path.join(repo, '.agents', 'skills')).isDirectory()).toBe(true);
    expect(existsSync(path.join(repo, '.agents', 'skills', 'x'))).toBe(false);
  });
});

function renameOver(from: string, to: string): void {
  renameSync(from, to);
}
