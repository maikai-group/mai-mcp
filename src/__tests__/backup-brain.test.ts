import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/backup-brain.sh');
const PLIST = path.resolve('scripts/com.mai.brain-backup.plist');
const CONTROLLER = readFileSync(path.resolve('src/scripts/backup.ts'), 'utf8');
const DELEGATE = readFileSync(SCRIPT, 'utf8');
const GITIGNORE = path.resolve('.gitignore');
const PRIVATE_RELEASE_MARKER = path.resolve('release/public');
const PUBLIC_GITIGNORE = path.resolve('release/public/gitignore');
const IS_PRIVATE_SOURCE = existsSync(PRIVATE_RELEASE_MARKER);

function privatePolicyFiles(privateSource: boolean, policyExists: boolean): string[] {
  if (privateSource && !policyExists) throw new Error('private release gitignore missing');
  return privateSource ? [PUBLIC_GITIGNORE] : [];
}

const PRIVATE_POLICY_FILES = privatePolicyFiles(IS_PRIVATE_SOURCE, existsSync(PUBLIC_GITIGNORE));

describe('brain database backups', () => {
  it('fails closed on private policy deletion while accepting public absence', () => {
    expect(() => privatePolicyFiles(true, false)).toThrow('private release gitignore missing');
    expect(privatePolicyFiles(false, false)).toEqual([]);
  });

  it('keeps SQL dumps local-only', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const plist = readFileSync(PLIST, 'utf8');
    const gitignore = readFileSync(GITIGNORE, 'utf8');

    expect(gitignore.split(/\r?\n/)).toContain('db/backups/*');
    expect(gitignore.split(/\r?\n/)).toContain('!db/backups/.gitkeep');
    for (const privatePolicy of PRIVATE_POLICY_FILES) {
      const publicGitignore = readFileSync(privatePolicy, 'utf8');
      expect(publicGitignore.split(/\r?\n/)).toContain('db/backups/*');
      expect(publicGitignore.split(/\r?\n/)).toContain('!db/backups/.gitkeep');
    }
    expect(script).not.toMatch(/\bgit (?:add|commit|push)\b/);
    expect(plist).not.toContain('--commit');
    expect(plist).not.toContain('--push');
    expect(plist).not.toContain('/bin/bash');
    expect(plist).toContain('<string>backup</string>');
    expect(plist).toContain('build/entry.js</string>');
  });

  it('ignores final and temporary dumps in private and assembled-public checkouts', () => {
    const policies = [GITIGNORE, ...PRIVATE_POLICY_FILES];
    for (const policy of policies) {
      const checkout = mkdtempSync(path.join(os.tmpdir(), 'mai-backup-ignore-test-'));
      try {
        mkdirSync(path.join(checkout, 'db/backups'), { recursive: true });
        writeFileSync(path.join(checkout, '.gitignore'), readFileSync(policy));
        writeFileSync(path.join(checkout, 'db/backups/probe.sql'), 'private dump');
        writeFileSync(
          path.join(checkout, 'db/backups/.2026-08-26.sql.ABCDEF'),
          'in-progress private dump'
        );
        writeFileSync(path.join(checkout, 'db/backups/.gitkeep'), '');
        execFileSync('git', ['init', '-q'], { cwd: checkout });
        for (const generated of [
          'db/backups/probe.sql',
          'db/backups/.2026-08-26.sql.ABCDEF',
        ]) {
          expect(
            spawnSync('git', ['check-ignore', '--quiet', generated], {
              cwd: checkout,
            }).status
          ).toBe(0);
        }
        expect(
          spawnSync('git', ['check-ignore', '--quiet', 'db/backups/.gitkeep'], {
            cwd: checkout,
          }).status
        ).toBe(1);
      } finally {
        rmSync(checkout, { recursive: true, force: true });
      }
    }
  });

  it('tracks no SQL backup snapshots', () => {
    const tracked = execFileSync('git', ['ls-files', 'db/backups/*.sql'], {
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });

  it('the Node controller reaches no git invocation and carries no commit/push contract', () => {
    // Negative control for R8 (decision 2cc63fc1): the retired shell-stub cases
    // are replaced by backup.test.ts's fake-child cases; this one proves the
    // controller cannot grow a git path without failing the suite.
    const code = CONTROLLER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/['"`]git['"`]/);
    expect(code).not.toMatch(/\bgit\s+(?:add|commit|push)\b/);
    for (const contract of ['interface BackupArgs', 'interface BackupResult']) {
      const start = code.indexOf(contract);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = code.slice(start, code.indexOf('}', start));
      expect(body).not.toMatch(/commit|push/i);
    }
    expect(DELEGATE).toContain('exec node "$SCRIPT_DIR/../build/entry.js" backup "$@"');
  });
});
