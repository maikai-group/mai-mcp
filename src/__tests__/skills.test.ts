/** Plan 15 Task 2: skill/reviewer lifecycle — hashing, inventory, four
 * states, targets and scopes, force, foreign preservation, duplicate scopes,
 * atomic failure injection, reference closure with a decoy consumer checker,
 * and the 05ec915d assert/prepare split. All destinations are temp homes;
 * nothing touches the operator's real ~/.claude or ~/.codex. */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashTree,
  shippedSkills,
  shippedReviewerAgents,
  classifySkill,
  classifyReviewerSuite,
  checkSkillReferenceClosure,
  runSkills,
  formatSkillResult,
  defaultSkillsIO,
  SkillsError,
  SKILL_SIDECAR,
  REVIEWER_SIDECAR,
} from '../scripts/skills.js';
import type { SkillsIO, SkillRunResult } from '../scripts/skills.js';
import {
  assertRepoManagedDestination,
  prepareRepoManagedDestination,
  RepoManagedWriteError,
} from '../repo-managed-write.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXED_NOW = new Date('2026-08-17T12:00:00.000Z');

function tmp(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeConsumerRepo(): string {
  const dir = tmp('mai-skills-consumer-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'plan15@test.invalid');
  git(dir, 'config', 'user.name', 'Plan 15 Fixture');
  writeFileSync(path.join(dir, 'README.md'), 'consumer\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

interface TestIOOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  env?: Record<string, string | undefined>;
  failurePoint?: SkillsIO['failurePoint'];
  realChecker?: boolean;
}
function makeIO(options: TestIOOptions = {}): SkillsIO & { home: string } {
  const home = tmp('mai-skills-home-');
  const real = defaultSkillsIO();
  return {
    home,
    platform: options.platform ?? process.platform,
    homedir: () => home,
    env: options.env ?? {},
    cwd: () => options.cwd ?? home,
    now: () => FIXED_NOW,
    gitToplevel: real.gitToplevel,
    runCommand:
      options.realChecker === true
        ? real.runCommand
        : () => ({ status: 0, stdout: '', stderr: '' }),
    failurePoint: options.failurePoint,
  };
}

function readTreeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string, base: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.isDirectory()) walk(full, relative);
      else out.set(relative, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dir, '');
  return out;
}

describe('hashTree', () => {
  it('frames path and content bytes, sorted, sidecar excluded', () => {
    const dir = tmp('mai-hash-');
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'b.txt'), 'bee');
    writeFileSync(path.join(dir, 'a.txt'), 'ay');
    writeFileSync(path.join(dir, 'nested', 'c.txt'), 'sea');

    const expectFor = (entries: Array<[string, string]>): string => {
      const hash = createHash('sha256');
      for (const [rel, content] of entries.sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        const p = Buffer.from(rel, 'utf8');
        const c = Buffer.from(content, 'utf8');
        const frame = (n: number): Buffer => {
          const b = Buffer.alloc(8);
          b.writeBigUInt64BE(BigInt(n));
          return b;
        };
        hash.update(frame(p.length));
        hash.update(p);
        hash.update(frame(c.length));
        hash.update(c);
      }
      return hash.digest('hex');
    };
    const expected = expectFor([
      ['a.txt', 'ay'],
      ['b.txt', 'bee'],
      ['nested/c.txt', 'sea'],
    ]);
    expect(hashTree(dir)).toBe(expected);

    // Sidecar exclusion: adding the install record does not change identity.
    writeFileSync(path.join(dir, SKILL_SIDECAR), '{"anything": true}');
    expect(hashTree(dir)).toBe(expected);

    // Creation order independence: same bytes in a second dir, other order.
    const dir2 = tmp('mai-hash-');
    mkdirSync(path.join(dir2, 'nested'));
    writeFileSync(path.join(dir2, 'nested', 'c.txt'), 'sea');
    writeFileSync(path.join(dir2, 'a.txt'), 'ay');
    writeFileSync(path.join(dir2, 'b.txt'), 'bee');
    expect(hashTree(dir2)).toBe(expected);
  });

  it('rejects symlinks and content changes move the hash', () => {
    const dir = tmp('mai-hash-sym-');
    writeFileSync(path.join(dir, 'a.txt'), 'ay');
    const before = hashTree(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'changed');
    expect(hashTree(dir)).not.toBe(before);
    symlinkSync('/etc/hosts', path.join(dir, 'link'));
    expect(() => hashTree(dir)).toThrow(/symlink/);
  });
});

describe('inventory', () => {
  it('enumerates exactly the twenty-one shipped skills and four reviewer agents', () => {
    const skills = shippedSkills();
    expect(skills.map((skill) => skill.name)).toEqual([
      'mai-code-review', 'mai-debug', 'mai-design', 'mai-docs-sync', 'mai-e2e',
      'mai-explore', 'mai-learn-workflow', 'mai-receiving-code-review',
      'mai-research', 'mai-skill-audit', 'mai-specialist-review',
      'mai-subagent-execute', 'mai-test-design', 'mai-verify', 'plan-compliance',
      'plan-execute', 'plan-review', 'plan-review-cycle', 'receiving-plan-review',
      'subagent-rules', 'write-plan',
    ]);
    const reviewers = shippedReviewerAgents();
    expect(reviewers.map((r) => r.name)).toEqual([
      'plan-reviewer-broad',
      'plan-reviewer-delta',
      'plan-reviewer-clearance',
      'plan-reviewer-clearance-max',
    ]);
  });

  it('installs specialist references in both harnesses and preserves local drift', () => {
    const io = makeIO();
    const specialist = shippedSkills().find((skill) => skill.name === 'mai-specialist-review');
    if (!specialist) throw new Error('missing specialist review skill');
    expect(runSkills({ action: 'install', target: 'all' }, io).ok).toBe(true);
    for (const harness of ['.claude', '.codex']) {
      const destRoot = path.join(io.home, harness, 'skills');
      for (const role of ['security', 'database', 'reliability', 'retrieval', 'tests']) {
        const relative = path.join('mai-specialist-review', 'references', `${role}.md`);
        expect(readFileSync(path.join(destRoot, relative), 'utf8'))
          .toBe(readFileSync(path.join(REPO_ROOT, 'skills', relative), 'utf8'));
      }
      expect(classifySkill(specialist, destRoot).state).toBe('current');
    }
    const codexRoot = path.join(io.home, '.codex', 'skills');
    const edited = path.join(codexRoot, 'mai-specialist-review', 'references', 'security.md');
    writeFileSync(edited, 'local specialist policy\n');
    expect(classifySkill(specialist, codexRoot).state).toBe('drifted');
    expect(runSkills({ action: 'install', target: 'codex' }, io).ok).toBe(false);
    expect(readFileSync(edited, 'utf8')).toBe('local specialist policy\n');
  });

  it('fails on a SKILL.md-less directory and a withheld reviewer', () => {
    const root = tmp('mai-inv-');
    mkdirSync(path.join(root, 'skills', 'broken'), { recursive: true });
    writeFileSync(path.join(root, 'skills', 'broken', 'notes.md'), 'no SKILL.md');
    expect(() => shippedSkills(root)).toThrow(/no SKILL\.md/);

    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    for (const name of ['plan-reviewer-broad', 'plan-reviewer-delta', 'plan-reviewer-clearance']) {
      writeFileSync(path.join(root, '.claude', 'agents', `${name}.md`), '---\n---\n');
    }
    expect(() => shippedReviewerAgents(root)).toThrow(/inventory mismatch/);
  });
});

describe('four states', () => {
  it('classifies missing, current, stale, drifted', () => {
    const io = makeIO();
    const [skill] = shippedSkills();
    const destRoot = path.join(io.home, '.claude', 'skills');

    expect(classifySkill(skill, destRoot).state).toBe('missing');

    const result = runSkills({ action: 'install', target: 'claude' }, io);
    expect(result.ok).toBe(true);
    expect(classifySkill(skill, destRoot).state).toBe('current');

    // Stale: installed matches its record, but the record differs from source.
    const installedDir = path.join(destRoot, skill.name);
    writeFileSync(path.join(installedDir, 'SKILL.md'), 'older shipped revision\n');
    const rehashed = hashTree(installedDir);
    const sidecarPath = path.join(installedDir, SKILL_SIDECAR);
    const sidecarRaw: unknown = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    if (typeof sidecarRaw !== 'object' || sidecarRaw === null) throw new Error('sidecar unreadable');
    writeFileSync(
      sidecarPath,
      `${JSON.stringify({ ...sidecarRaw, sha: rehashed }, null, 2)}\n`
    );
    expect(classifySkill(skill, destRoot).state).toBe('stale');

    // Drifted: installed bytes differ from the record.
    writeFileSync(path.join(installedDir, 'SKILL.md'), 'locally edited\n');
    expect(classifySkill(skill, destRoot).state).toBe('drifted');
  });

  it('reviewer suite classifies missing, current, and partial deletion as drifted', () => {
    const io = makeIO();
    const reviewers = shippedReviewerAgents();
    const agentsDir = path.join(io.home, '.claude', 'agents');
    expect(classifyReviewerSuite(reviewers, agentsDir).state).toBe('missing');

    runSkills({ action: 'install', target: 'claude' }, io);
    expect(classifyReviewerSuite(reviewers, agentsDir).state).toBe('current');

    // Withhold one installed reviewer: partial shipped artifact drifts.
    const victim = path.join(agentsDir, 'plan-reviewer-delta.md');
    execFileSync('rm', [victim]);
    const partial = classifyReviewerSuite(reviewers, agentsDir);
    expect(partial.state).toBe('drifted');
    expect(partial.detail).toMatch(/partially deleted/);
  });
});

describe('install / upgrade behavior', () => {
  it('stale replaces; a second install writes nothing (idempotent bytes)', () => {
    const io = makeIO();
    runSkills({ action: 'install', target: 'claude' }, io);
    const destRoot = path.join(io.home, '.claude', 'skills');
    const before = readTreeBytes(destRoot);
    const second = runSkills({ action: 'install', target: 'claude' }, io);
    expect(second.ok).toBe(true);
    expect(second.items.every((item) => item.action === 'none')).toBe(true);
    expect(readTreeBytes(destRoot)).toEqual(before);

    // Make one skill stale, then upgrade replaces it and reports upgraded.
    const [skill] = shippedSkills();
    const installedDir = path.join(destRoot, skill.name);
    writeFileSync(path.join(installedDir, 'SKILL.md'), 'older shipped revision\n');
    const rehashed = hashTree(installedDir);
    const sidecarPath = path.join(installedDir, SKILL_SIDECAR);
    const sidecarRaw: unknown = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    if (typeof sidecarRaw !== 'object' || sidecarRaw === null) throw new Error('sidecar unreadable');
    writeFileSync(sidecarPath, `${JSON.stringify({ ...sidecarRaw, sha: rehashed }, null, 2)}\n`);

    const upgraded = runSkills({ action: 'upgrade', target: 'claude' }, io);
    expect(upgraded.ok).toBe(true);
    const item = upgraded.items.find((entry) => entry.name === skill.name);
    expect(item?.action).toBe('upgraded');
    expect(classifySkill(skill, destRoot).state).toBe('current');
  });

  it('drift refuses without --force and force repairs shipped names only', () => {
    const io = makeIO();
    runSkills({ action: 'install', target: 'claude' }, io);
    const destRoot = path.join(io.home, '.claude', 'skills');
    const [skill] = shippedSkills();
    writeFileSync(path.join(destRoot, skill.name, 'SKILL.md'), 'locally edited\n');

    const refused = runSkills({ action: 'install', target: 'claude' }, io);
    expect(refused.ok).toBe(false);
    const refusedItem = refused.items.find((entry) => entry.name === skill.name);
    expect(refusedItem?.action).toBe('refused');
    // Refusal is atomic: the drifted bytes were not touched.
    expect(readFileSync(path.join(destRoot, skill.name, 'SKILL.md'), 'utf8')).toBe(
      'locally edited\n'
    );

    const forced = runSkills({ action: 'install', target: 'claude', force: true }, io);
    expect(forced.ok).toBe(true);
    expect(classifySkill(skill, destRoot).state).toBe('current');
  });

  it('preserves foreign artifacts byte-identical', () => {
    const io = makeIO();
    const destRoot = path.join(io.home, '.claude', 'skills');
    mkdirSync(path.join(destRoot, 'my-own-skill'), { recursive: true });
    writeFileSync(path.join(destRoot, 'my-own-skill', 'SKILL.md'), 'mine, not shipped\n');
    writeFileSync(path.join(destRoot, 'notes.txt'), 'foreign file\n');
    const foreignBefore = readTreeBytes(path.join(destRoot, 'my-own-skill'));

    const result = runSkills({ action: 'install', target: 'claude', force: true }, io);
    expect(result.ok).toBe(true);
    expect(readTreeBytes(path.join(destRoot, 'my-own-skill'))).toEqual(foreignBefore);
    expect(readFileSync(path.join(destRoot, 'notes.txt'), 'utf8')).toBe('foreign file\n');
  });

  it('injected atomic failures leave the prior set intact', () => {
    const io = makeIO();
    runSkills({ action: 'install', target: 'claude' }, io);
    const destRoot = path.join(io.home, '.claude', 'skills');
    // Make everything stale so a full rewrite is planned.
    for (const skill of shippedSkills()) {
      const dir = path.join(destRoot, skill.name);
      writeFileSync(path.join(dir, 'SKILL.md'), 'older shipped revision\n');
      const rehashed = hashTree(dir);
      const sidecarPath = path.join(dir, SKILL_SIDECAR);
      const raw: unknown = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      if (typeof raw !== 'object' || raw === null) throw new Error('sidecar unreadable');
      writeFileSync(sidecarPath, `${JSON.stringify({ ...raw, sha: rehashed }, null, 2)}\n`);
    }
    const before = readTreeBytes(destRoot);

    let stageCalls = 0;
    const failingIO: SkillsIO = {
      ...io,
      failurePoint: (phase) => {
        if (phase !== 'stage') return;
        stageCalls += 1;
        if (stageCalls === 3) throw new Error('injected stage failure');
      },
    };
    expect(() => runSkills({ action: 'upgrade', target: 'claude' }, failingIO)).toThrow(
      /injected stage failure/
    );
    expect(readTreeBytes(destRoot)).toEqual(before);
    expect(readdirSync(destRoot).some((name) => name.startsWith('.mai-stage-'))).toBe(false);
  });
});

describe('targets and scopes', () => {
  it('claude-only rejects an explicit codex scope', () => {
    const io = makeIO();
    expect(() =>
      runSkills({ action: 'status', target: 'claude', codexScope: 'user' }, io)
    ).toThrow(/codex target/);
  });

  it('codex user scope resolves CODEX_HOME', () => {
    const codexHome = tmp('mai-codex-home-');
    const io = makeIO({ env: { CODEX_HOME: codexHome } });
    const result = runSkills({ action: 'install', target: 'codex' }, io);
    expect(result.ok).toBe(true);
    expect(result.targets).toEqual(['codex:user']);
    expect(existsSync(path.join(codexHome, 'skills', 'plan-review', 'SKILL.md'))).toBe(true);
    // Default without CODEX_HOME: ~/.codex/skills under the injected home.
    const io2 = makeIO();
    runSkills({ action: 'install', target: 'codex' }, io2);
    expect(existsSync(path.join(io2.home, '.codex', 'skills', 'plan-review', 'SKILL.md'))).toBe(
      true
    );
  });

  it('keeps the Codex user destination home-derived on Windows', () => {
    const codexHome = tmp('mai-windows-codex-home-');
    const io = makeIO({ platform: 'win32', env: { CODEX_HOME: codexHome } });
    const result = runSkills(
      { action: 'status', target: 'codex', codexScope: 'user' },
      io
    );

    expect(result.ok).toBe(true);
    expect(result.targets).toEqual(['codex:user']);
    expect(new Set(result.items.map((item) => item.destination))).toEqual(
      new Set([path.join(codexHome, 'skills')])
    );
  });

  it('repo scope installs through the contained boundary; requires a git repo', () => {
    const consumer = makeConsumerRepo();
    const io = makeIO({ cwd: consumer });
    const result = runSkills(
      { action: 'install', target: 'codex', codexScope: 'repo' },
      io
    );
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(consumer, '.agents', 'skills', 'plan-review', 'SKILL.md'))).toBe(
      true
    );
    const nonRepo = makeIO({ cwd: tmp('mai-non-repo-') });
    expect(() =>
      runSkills({ action: 'install', target: 'codex', codexScope: 'repo' }, nonRepo)
    ).toThrow(/git repository/);
  });

  it('keeps the Codex repo destination repo-derived on Windows', () => {
    const consumer = makeConsumerRepo();
    const io = makeIO({ platform: 'win32', cwd: consumer });
    const result = runSkills(
      { action: 'status', target: 'codex', codexScope: 'repo' },
      io
    );

    expect(result.ok).toBe(true);
    expect(result.targets).toEqual(['codex:repo']);
    expect(new Set(result.items.map((item) => item.destination))).toEqual(
      new Set([path.join(realpathOf(consumer), '.agents', 'skills')])
    );
  });

  it('admin scope never elevates and prints exact manual sudo commands', () => {
    // POSIX-only premise: admin scope is the /etc/codex/skills + sudo path, which runSkills refuses outright on win32 (covered by 'refuses Windows Codex admin scope before destination or write calls').
    if (process.platform === 'win32') return;
    const io = makeIO();
    const result = runSkills(
      { action: 'install', target: 'codex', codexScope: 'admin' },
      io
    );
    expect(result.ok).toBe(false);
    expect(result.notes.join('\n')).toContain('sudo mkdir -p /etc/codex/skills');
    expect(result.notes.join('\n')).toContain('sudo cp -R');
    expect(existsSync('/etc/codex/skills')).toBe(false);
  });

  it('refuses Windows Codex admin scope before destination or write calls', () => {
    for (const target of ['codex', 'all'] as const) {
      const base = makeIO({ platform: 'win32' });
      let destinationCalls = 0;
      let writeCalls = 0;
      const io: SkillsIO = {
        ...base,
        homedir: () => {
          destinationCalls += 1;
          return base.home;
        },
        cwd: () => {
          destinationCalls += 1;
          return base.home;
        },
        gitToplevel: () => {
          destinationCalls += 1;
          return null;
        },
        runCommand: () => {
          writeCalls += 1;
          return { status: 0, stdout: '', stderr: '' };
        },
        failurePoint: () => {
          writeCalls += 1;
        },
      };

      expect(() =>
        runSkills({ action: 'install', target, codexScope: 'admin' }, io)
      ).toThrow(
        new SkillsError(
          'Codex admin scope is not supported on native Windows; use --codex-scope user or repo'
        )
      );
      expect(destinationCalls).toBe(0);
      expect(writeCalls).toBe(0);
      expect(existsSync(path.join(base.home, '.claude'))).toBe(false);
      expect(existsSync(path.join(base.home, '.codex'))).toBe(false);
    }
  });

  it('never produces a C:\\etc\\codex\\skills destination on Windows', () => {
    const userIO = makeIO({ platform: 'win32' });
    const consumer = makeConsumerRepo();
    const repoIO = makeIO({ platform: 'win32', cwd: consumer });
    const results = [
      runSkills({ action: 'status', target: 'codex', codexScope: 'user' }, userIO),
      runSkills({ action: 'status', target: 'codex', codexScope: 'repo' }, repoIO),
    ];
    const destinations = results.flatMap((result) =>
      result.items.map((item) => item.destination)
    );

    expect(destinations).not.toContain('C:\\etc\\codex\\skills');
    expect(() =>
      runSkills(
        { action: 'status', target: 'codex', codexScope: 'admin' },
        makeIO({ platform: 'win32' })
      )
    ).toThrow(/Codex admin scope is not supported on native Windows/);
  });

  it('refuses same-name duplicates in another codex discovery scope', () => {
    const consumer = makeConsumerRepo();
    mkdirSync(path.join(consumer, '.agents', 'skills', 'plan-review'), { recursive: true });
    writeFileSync(
      path.join(consumer, '.agents', 'skills', 'plan-review', 'SKILL.md'),
      'duplicate in repo scope\n'
    );
    const io = makeIO({ cwd: consumer });
    const result = runSkills({ action: 'install', target: 'codex' }, io);
    expect(result.ok).toBe(false);
    expect(result.notes.join('\n')).toMatch(/plan-review.*repo scope/);
    // Refusal happened before any user-scope write.
    expect(existsSync(path.join(io.home, '.codex', 'skills'))).toBe(false);
  });
});

describe('reference closure', () => {
  it('runs the real MAI_ROOT checker, never a decoy from the consumer cwd', () => {
    const consumer = tmp('mai-decoy-consumer-');
    mkdirSync(path.join(consumer, 'scripts'), { recursive: true });
    const marker = path.join(consumer, 'decoy-ran.marker');
    writeFileSync(
      path.join(consumer, 'scripts', 'check-skills.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'decoy');\nprocess.exit(0);\n`
    );
    const io = makeIO({ cwd: consumer, realChecker: true });
    const result = runSkills({ action: 'install', target: 'claude' }, io);
    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('a failing checker makes the source suite invalid', () => {
    const io = makeIO();
    const failing: SkillsIO = {
      ...io,
      runCommand: () => ({ status: 3, stdout: '', stderr: 'closure broken' }),
    };
    expect(() => checkSkillReferenceClosure(failing)).toThrow(/exited 3/);
    expect(() => runSkills({ action: 'install', target: 'claude' }, failing)).toThrow(
      /exited 3/
    );
  });
});

describe('repo-managed destination boundary (05ec915d)', () => {
  it('assertion accepts a missing .agents/skills without creating .agents', () => {
    const consumer = makeConsumerRepo();
    const resolved = assertRepoManagedDestination(consumer, path.join('.agents', 'skills'));
    expect(resolved).toBe(path.join(realpathOf(consumer), '.agents', 'skills'));
    expect(existsSync(path.join(consumer, '.agents'))).toBe(false);
    // Preparation is the mutation phase: creates parents one at a time.
    prepareRepoManagedDestination(consumer, path.join('.agents', 'skills', '.mai-anchor'));
    expect(lstatSync(path.join(consumer, '.agents')).isDirectory()).toBe(true);
    expect(lstatSync(path.join(consumer, '.agents', 'skills')).isDirectory()).toBe(true);
    expect(existsSync(path.join(consumer, '.agents', 'skills', '.mai-anchor'))).toBe(false);
  });

  it('rejects escaping, absolute, and NUL paths without writes', () => {
    const consumer = makeConsumerRepo();
    for (const bad of ['../outside.md', '/etc/passwd', 'C:\\evil', 'a\0b', '..']) {
      expect(() => assertRepoManagedDestination(consumer, bad)).toThrow(RepoManagedWriteError);
    }
    expect(existsSync(path.join(consumer, '.agents'))).toBe(false);
  });

  it.each([
    ['.agents'],
    [path.join('.agents', 'skills')],
  ])('repo-scope install fails before staging when %s is an outside symlink', (linkRel) => {
    const consumer = makeConsumerRepo();
    const victim = tmp('mai-victim-');
    writeFileSync(path.join(victim, 'sentinel.txt'), 'untouched\n');
    const victimBefore = readTreeBytes(victim);
    const linkPath = path.join(consumer, linkRel);
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(victim, linkPath);

    const io = makeIO({ cwd: consumer });
    expect(() =>
      runSkills({ action: 'install', target: 'codex', codexScope: 'repo' }, io)
    ).toThrow(RepoManagedWriteError);
    expect(readTreeBytes(victim)).toEqual(victimBefore);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it('a symlinked final destination component fails before staging', () => {
    const consumer = makeConsumerRepo();
    const victim = tmp('mai-victim-final-');
    writeFileSync(path.join(victim, 'sentinel.txt'), 'untouched\n');
    const victimBefore = readTreeBytes(victim);
    const [skill] = shippedSkills();
    mkdirSync(path.join(consumer, '.agents', 'skills'), { recursive: true });
    symlinkSync(victim, path.join(consumer, '.agents', 'skills', skill.name));

    const io = makeIO({ cwd: consumer });
    expect(() =>
      runSkills({ action: 'install', target: 'codex', codexScope: 'repo', force: true }, io)
    ).toThrow(RepoManagedWriteError);
    expect(readTreeBytes(victim)).toEqual(victimBefore);
  });
});

function realpathOf(dir: string): string {
  return execFileSync('realpath', [dir], { encoding: 'utf8' }).trim();
}

describe('reporting', () => {
  it('formats separate skill and reviewer groups plus the Claude restart note', () => {
    const io = makeIO();
    const result: SkillRunResult = runSkills({ action: 'install', target: 'all' }, io);
    expect(result.ok).toBe(true);
    const text = formatSkillResult(result);
    expect(text).toContain('claude skills:');
    expect(text).toContain('codex user skills:');
    expect(text).toContain('claude reviewer agents:');
    expect(text).toContain('restart Claude Code');
    expect(text).toContain('skills: OK');
    const failing = formatSkillResult({ ...result, ok: false });
    expect(failing).toContain('skills: FAILED');
  });

  it('status is read-only and reports without writing', () => {
    const io = makeIO();
    const result = runSkills({ action: 'status', target: 'all' }, io);
    expect(result.ok).toBe(true);
    expect(result.items.every((item) => item.action === 'none')).toBe(true);
    expect(result.items.every((item) => item.state === 'missing')).toBe(true);
    expect(existsSync(path.join(io.home, '.claude'))).toBe(false);
    expect(existsSync(path.join(io.home, '.codex'))).toBe(false);
  });
});

describe('negative controls', () => {
  it('an edited installed byte fails install for the drift reason', () => {
    const io = makeIO();
    runSkills({ action: 'install', target: 'claude' }, io);
    const destRoot = path.join(io.home, '.claude', 'skills');
    writeFileSync(path.join(destRoot, 'plan-review', 'SKILL.md'), 'tampered\n');
    const result = runSkills({ action: 'install', target: 'claude' }, io);
    expect(result.ok).toBe(false);
    expect(result.notes.join('\n')).toMatch(/plan-review: drifted/);
  });

  it('a removed source skill fails enumeration for the missing-SKILL.md reason', () => {
    // Fixture root: copy two real skills, then break one.
    const root = tmp('mai-src-fixture-');
    const [a, b] = shippedSkills();
    cpSync(a.dir, path.join(root, 'skills', a.name), { recursive: true });
    cpSync(b.dir, path.join(root, 'skills', b.name), { recursive: true });
    execFileSync('rm', [path.join(root, 'skills', b.name, 'SKILL.md')]);
    expect(() => shippedSkills(root)).toThrow(/no SKILL\.md/);
  });
});
