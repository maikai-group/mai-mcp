import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeTool } from './support/fake-tool.js';

const SCRIPTS_DIR = path.resolve('skills/plan-review-cycle/scripts');
const HELPER = path.join(SCRIPTS_DIR, 'review-scratch.mjs');
const WRAPPER = path.join(SCRIPTS_DIR, 'review-scratch.sh');
const PLIST = path.join(SCRIPTS_DIR, 'com.mai.review-tmp-janitor.plist');
const INSTALLER = path.join(SCRIPTS_DIR, 'install-janitor.sh');
const BACKUP_PLIST = path.resolve('scripts/com.mai.brain-backup.plist');
const MARKER = '.mai-review-scratch-v1';
const PLIST_TEMPLATE_ARGV = ['node', 'review-scratch.mjs', 'prune', '--days', '7'];
const POSIX = process.platform !== 'win32';
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'mai-review-scratch-test-'));
  roots.push(value);
  return value;
}

function run(tmpRoot: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MAI_REVIEW_TMP_ROOT: tmpRoot, ...env },
  }).trim();
}

function runWrapper(tmpRoot: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MAI_REVIEW_TMP_ROOT: tmpRoot, ...env },
  }).trim();
}

function tryRun(tmpRoot: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MAI_REVIEW_TMP_ROOT: tmpRoot, ...env },
  });
}

function makeLsof(rootDir: string, body = 'exit 1'): string {
  return installFakeTool(rootDir, `lsof-${Math.random().toString(16).slice(2)}`, body, { mode: 0o700 });
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Backdate the marker's created_at — age is measured from the NEWER of the
 * marker and the tree, so an old tree under a fresh marker is not old. */
function backdateMarker(tree: string, days = 10): void {
  const marker = path.join(tree, MARKER);
  if (!existsSync(marker)) return;
  const stamp = daysAgo(days).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const text = readFileSync(marker, 'utf8').replace(/^created_at=.*$/m, `created_at=${stamp}`);
  writeFileSync(marker, text);
}

function makeOld(tree: string, days = 10): void {
  const when = daysAgo(days);
  backdateMarker(tree, days);
  const visit = (current: string): void => {
    if (lstatSync(current).isDirectory()) {
      for (const name of readdirSync(current)) visit(path.join(current, name));
    }
    utimesSync(current, when, when);
  };
  visit(tree);
}

/** The legacy shell writer's create path, frozen as a fixture: the exact
 * marker bytes review-scratch.sh wrote before the Node port (three key=value
 * lines, uid ownership, 0700 root). It lives here rather than in git history
 * so the assembled public package, which ships no history, runs it too. */
const LEGACY_SHELL_WRITER = `#!/usr/bin/env bash
set -euo pipefail
MARKER='.mai-review-scratch-v1'
PREFIX='mai-plan-review-pass.'
root="$(cd -P "\${MAI_REVIEW_TMP_ROOT:-\${TMPDIR:-/tmp}}" && pwd)"
scratch="$(mktemp -d "$root/$PREFIX"'XXXXXX')"
chmod 700 "$scratch"
mkdir -p "$scratch/tmp" "$scratch/npm-cache"
chmod 700 "$scratch/tmp" "$scratch/npm-cache"
{
  printf 'version=1\\n'
  printf 'uid=%s\\n' "$(id -u)"
  printf 'created_at=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$scratch/$MARKER"
chmod 600 "$scratch/$MARKER"
printf '%s\\n' "$scratch"
`;

function legacyShellHelper(dir: string): string {
  const file = path.join(dir, 'legacy-review-scratch.sh');
  writeFileSync(file, LEGACY_SHELL_WRITER);
  chmodSync(file, 0o700);
  return file;
}

function plistArgv(file: string): string[] {
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('plist did not parse to an object');
  const argv = Reflect.get(parsed, 'ProgramArguments');
  if (!Array.isArray(argv)) throw new Error('ProgramArguments is not an array');
  return argv.map(String);
}

/** A janitor fixture: HOME, isolated launchctl and, unless a real one is
 * requested, a plutil stub. Returns the environment and the LaunchAgents dir. */
function janitorFixture(tmpRoot: string, { realPlutil = false, launchctlBody }: { realPlutil?: boolean; launchctlBody?: string } = {}) {
  const home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  const state = path.join(tmpRoot, 'state');
  mkdirSync(state);
  const launchctl = installFakeTool(tmpRoot, 'launchctl', launchctlBody ?? `#!/bin/sh
set -eu
state=${JSON.stringify(state)}
case "$1" in
  print)
    if test -f "$state/loaded"; then exit 0; fi
    echo 'Could not find service "com.mai.review-tmp-janitor"' >&2
    exit 113
    ;;
  bootout) rm -f "$state/loaded" ;;
  bootstrap) touch "$state/loaded" ;;
  kickstart) test -f "$state/loaded" ;;
esac
`);
  chmodSync(launchctl, 0o700);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    MAI_REVIEW_PLATFORM: 'Darwin',
    MAI_REVIEW_LAUNCHCTL: launchctl,
  };
  if (!realPlutil) env.MAI_REVIEW_PLUTIL = makeLsof(tmpRoot, 'exit 0');
  return { env, state, agents: path.join(home, 'Library/LaunchAgents') };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('review scratch lifecycle', () => {
  it('creates one private marked direct child and removes only that managed root', () => {
    const tmpRoot = root();
    const scratch = run(tmpRoot, ['create']);

    expect(path.dirname(scratch)).toBe(realpathSync(tmpRoot));
    expect(path.basename(scratch)).toMatch(/^mai-plan-review-pass\./);
    if (POSIX) expect(statSync(scratch).mode & 0o777).toBe(0o700);
    expect(existsSync(path.join(scratch, MARKER))).toBe(true);
    expect(existsSync(path.join(scratch, 'tmp'))).toBe(true);
    expect(existsSync(path.join(scratch, 'npm-cache'))).toBe(true);
    const marker = readFileSync(path.join(scratch, MARKER), 'utf8');
    expect(marker).toMatch(/^version=1\nuid=\d+\ncreated_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/);

    expect(run(tmpRoot, ['cleanup', scratch])).toContain('removed:');
    expect(existsSync(scratch)).toBe(false);
    expect(run(tmpRoot, ['cleanup', scratch])).toContain('already absent:');
  });

  it('the POSIX wrapper is a strict delegate to the canonical helper', () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const wrapper = readFileSync(WRAPPER, 'utf8');
    expect(wrapper).toContain('exec node "$SCRIPT_DIR/review-scratch.mjs" "$@"');
    expect(wrapper.split('\n').filter((line) => line.trim() && !line.startsWith('#'))).toHaveLength(3);
    const scratch = runWrapper(tmpRoot, ['create']);
    expect(existsSync(path.join(scratch, MARKER))).toBe(true);
    expect(runWrapper(tmpRoot, ['cleanup', scratch])).toContain('removed:');
    expect(existsSync(scratch)).toBe(false);
    expect(execFileSync('bash', [WRAPPER, '--help'], { encoding: 'utf8' })).toContain('review-scratch.mjs create');
  });

  it('refuses an unmarked lookalike and a symlink instead of broad-deleting', () => {
    const tmpRoot = root();
    const unmarked = path.join(tmpRoot, 'mai-plan-review-pass.unmarked');
    mkdirSync(unmarked);
    const outside = path.join(tmpRoot, 'outside');
    mkdirSync(outside);
    const link = path.join(tmpRoot, 'mai-plan-review-pass.link');
    symlinkSync(outside, link, 'dir');

    expect(() => run(tmpRoot, ['cleanup', unmarked])).toThrow();
    expect(() => run(tmpRoot, ['cleanup', link])).toThrow();
    expect(existsSync(unmarked)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('cleanup requires a direct child of the temp root', () => {
    const tmpRoot = root();
    const nested = path.join(tmpRoot, 'sub', 'mai-plan-review-pass.nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, MARKER), `version=1\nuid=${process.getuid?.() ?? 0}\ncreated_at=2026-01-01T00:00:00Z\n`);
    const result = tryRun(tmpRoot, ['cleanup', nested]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a direct child');
    expect(existsSync(nested)).toBe(true);
  });

  it('prunes only old marked roots and retains every markerless near-miss', () => {
    const tmpRoot = root();
    const noOpenLsof = makeLsof(tmpRoot);
    const managed = run(tmpRoot, ['create']);
    writeFileSync(path.join(managed, 'repo-copy'), 'x');
    makeOld(managed);

    const nearMisses = [
      'plan26-review-old',
      'mai-planets-user-data',
      'plan2-personal-notes',
      'plan-not-a-review-copy',
      'mai-plan-review-pass.unmarked',
    ].map((name) => path.join(tmpRoot, name));
    for (const value of nearMisses) {
      mkdirSync(value);
      writeFileSync(path.join(value, 'keep'), 'x');
      makeOld(value);
    }

    const fresh = run(tmpRoot, ['create']);
    const pruned = tryRun(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(existsSync(managed), `${pruned.stdout}\n${pruned.stderr}`).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    for (const value of nearMisses) expect(existsSync(value)).toBe(true);
    expect(readdirSync(tmpRoot).filter((name) => name.startsWith('.mai-review-tombstone.'))).toHaveLength(0);
  });

  it('dry-run reports an eligible tree without removing it', () => {
    const tmpRoot = root();
    const noOpenLsof = makeLsof(tmpRoot);
    const managed = run(tmpRoot, ['create']);
    makeOld(managed);

    const output = run(tmpRoot, ['prune', '--days', '7', '--dry-run'], {
      MAI_REVIEW_LSOF: noOpenLsof,
    });
    expect(output).toContain(`would remove: ${managed}`);
    expect(existsSync(managed)).toBe(true);
  });

  it('uses the explicit roots shared by the LaunchAgent and pass creation', () => {
    const userRoot = root();
    const systemRoot = root();
    const noOpenLsof = makeLsof(userRoot);
    const scratch = execFileSync(process.execPath, [HELPER, 'create'], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: userRoot, TMP: userRoot, TEMP: userRoot, MAI_REVIEW_TMP_ROOT: '' },
    }).trim();
    makeOld(scratch);

    execFileSync(process.execPath, [HELPER, 'prune', '--days', '7', '--root', userRoot, '--root', systemRoot], {
      env: {
        ...process.env,
        TMPDIR: systemRoot,
        MAI_REVIEW_TMP_ROOT: '',
        MAI_REVIEW_LSOF: noOpenLsof,
      },
    });
    expect(existsSync(scratch)).toBe(false);
  });

  it('prune with no --root covers the per-user temp root and /private/tmp on macOS', () => {
    if (process.platform !== 'darwin') return;
    const userRoot = root();
    const noOpenLsof = makeLsof(userRoot);
    const userScratch = execFileSync(process.execPath, [HELPER, 'create'], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: userRoot, MAI_REVIEW_TMP_ROOT: '' },
    }).trim();
    const systemScratch = execFileSync(process.execPath, [HELPER, 'create'], {
      encoding: 'utf8',
      env: { ...process.env, MAI_REVIEW_TMP_ROOT: '/private/tmp' },
    }).trim();
    roots.push(systemScratch);
    expect(path.dirname(systemScratch)).toBe('/private/tmp');
    makeOld(userScratch);
    makeOld(systemScratch);

    const output = execFileSync(process.execPath, [HELPER, 'prune', '--days', '7', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: userRoot, MAI_REVIEW_TMP_ROOT: '', MAI_REVIEW_LSOF: noOpenLsof },
    });
    expect(output).toContain(`would remove: ${userScratch}`);
    expect(output).toContain(`would remove: ${systemScratch}`);
    expect(existsSync(userScratch)).toBe(true);
    expect(existsSync(systemScratch)).toBe(true);
  });

  it('a root the legacy shell helper wrote is cleaned up and pruned unchanged', () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const legacy = legacyShellHelper(tmpRoot);
    const env = { ...process.env, MAI_REVIEW_TMP_ROOT: tmpRoot };
    const first = execFileSync('bash', [legacy, 'create'], { encoding: 'utf8', env }).trim();
    const legacyMarker = readFileSync(path.join(first, MARKER), 'utf8');
    expect(legacyMarker.split('\n').filter(Boolean)).toHaveLength(3);
    expect(run(tmpRoot, ['cleanup', first])).toContain('removed:');
    expect(existsSync(first)).toBe(false);

    const second = execFileSync('bash', [legacy, 'create'], { encoding: 'utf8', env }).trim();
    makeOld(second);
    expect(readFileSync(path.join(second, MARKER), 'utf8')).not.toContain('{');
    run(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: makeLsof(tmpRoot) });
    expect(existsSync(second)).toBe(false);
  });

  it('ignores additive marker keys and requires version and uid', () => {
    const tmpRoot = root();
    const scratch = run(tmpRoot, ['create']);
    const marker = path.join(scratch, MARKER);
    writeFileSync(marker, `${readFileSync(marker, 'utf8')}creator_pid=12345\nfuture_key=anything\n`);
    expect(run(tmpRoot, ['cleanup', scratch])).toContain('removed:');

    const noUid = run(tmpRoot, ['create']);
    writeFileSync(path.join(noUid, MARKER), 'version=1\ncreated_at=2026-01-01T00:00:00Z\n');
    expect(() => run(tmpRoot, ['cleanup', noUid])).toThrow();
    expect(existsSync(noUid)).toBe(true);

    const wrongUid = run(tmpRoot, ['create']);
    writeFileSync(path.join(wrongUid, MARKER), 'version=1\nuid=999999\ncreated_at=2026-01-01T00:00:00Z\n');
    expect(() => run(tmpRoot, ['cleanup', wrongUid])).toThrow();
    expect(existsSync(wrongUid)).toBe(true);
  });

  it('an old marker whose tree was touched within the window is active and survives', () => {
    const tmpRoot = root();
    const noOpenLsof = makeLsof(tmpRoot);
    const managed = run(tmpRoot, ['create']);
    const recent = path.join(managed, 'tmp', 'still-working');
    writeFileSync(recent, 'x');
    makeOld(managed, 10);
    const now = new Date();
    utimesSync(recent, now, now);

    run(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(existsSync(managed)).toBe(true);

    utimesSync(recent, daysAgo(10), daysAgo(10));
    const pruned = tryRun(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(existsSync(managed), `${pruned.stdout}\n${pruned.stderr}`).toBe(false);
  });

  it('an old tree under a fresh marker is not old', () => {
    const tmpRoot = root();
    const noOpenLsof = makeLsof(tmpRoot);
    const managed = run(tmpRoot, ['create']);
    const when = daysAgo(10);
    for (const name of readdirSync(managed)) utimesSync(path.join(managed, name), when, when);
    utimesSync(managed, when, when);
    run(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(existsSync(managed)).toBe(true);
  });

  it('retains old roots when lsof is missing, failing, or reports an open file', async () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const managed = run(tmpRoot, ['create']);
    const heldFile = path.join(managed, 'held-open');
    writeFileSync(heldFile, 'x');
    makeOld(managed);

    const missing = tryRun(tmpRoot, ['prune', '--days', '7', '--dry-run'], { MAI_REVIEW_LSOF: '/missing/lsof' });
    expect(missing.stderr).toContain('lsof is unavailable');
    expect(missing.stdout).not.toContain('would remove:');

    const failingLsof = makeLsof(tmpRoot, 'echo detector-failed >&2; exit 2');
    const failed = tryRun(tmpRoot, ['prune', '--days', '7', '--dry-run'], { MAI_REVIEW_LSOF: failingLsof });
    expect(failed.stderr).toContain('lsof failed (status 2)');
    expect(failed.stdout).not.toContain('would remove:');

    const silentSuccess = makeLsof(tmpRoot, 'exit 0');
    const vacuous = tryRun(tmpRoot, ['prune', '--days', '7', '--dry-run'], { MAI_REVIEW_LSOF: silentSuccess });
    expect(vacuous.stderr).toContain('lsof returned success without a result');
    expect(vacuous.stdout).not.toContain('would remove:');

    const realLsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(existsSync);
    if (!realLsof) return;
    const holder = spawn(process.execPath, [
      '-e',
      'const fs=require("fs");fs.openSync(process.argv[1],"r");process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      heldFile,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout?.once('data', () => resolve());
    });
    try {
      const open = run(tmpRoot, ['prune', '--days', '7', '--dry-run'], {
        MAI_REVIEW_LSOF: realLsof,
      });
      expect(open).not.toContain('would remove:');
      expect(existsSync(managed)).toBe(true);
    } finally {
      holder.kill('SIGTERM');
    }
  });

  it('Windows: retains a root while a file is held open and removes it once released', async () => {
    if (process.platform !== 'win32') return;
    const tmpRoot = root();
    const managed = run(tmpRoot, ['create']);
    const held = path.join(managed, 'held-open');
    writeFileSync(held, 'x');
    makeOld(managed);
    const quoted = `'${held.replace(/'/g, "''")}'`;
    const holder = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$f = [System.IO.File]::Open(${quoted}, 'Open', 'Read', [System.IO.FileShare]::None); `
      + "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Dispose()",
    ], { stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout?.once('data', () => resolve());
    });
    try {
      const open = tryRun(tmpRoot, ['prune', '--days', '7']);
      expect(open.status).toBe(0);
      expect(open.stdout).not.toContain('removed:');
      // Detection, not a probe failure: the fail-closed path would also retain.
      expect(open.stderr).toContain('a file in the tree is held open');
      expect(existsSync(managed)).toBe(true);
    } finally {
      holder.stdin?.write('\n');
      holder.stdin?.end();
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    }
    const released = tryRun(tmpRoot, ['prune', '--days', '7']);
    expect(released.status).toBe(0);
    expect(released.stdout, released.stderr).toContain('removed:');
    expect(existsSync(managed)).toBe(false);
  });

  it('retains an old root when the freshness scan cannot enumerate the tree', () => {
    if (!POSIX || process.getuid?.() === 0) return;
    const tmpRoot = root();
    const managed = run(tmpRoot, ['create']);
    const sealed = path.join(managed, 'sealed');
    mkdirSync(sealed);
    writeFileSync(path.join(sealed, 'inner'), 'x');
    makeOld(managed);
    chmodSync(sealed, 0o000);
    try {
      const result = tryRun(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: makeLsof(tmpRoot) });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('freshness scan failed');
      expect(result.stdout).not.toContain('removed:');
      expect(existsSync(managed)).toBe(true);
    } finally {
      chmodSync(sealed, 0o700);
    }
  });

  it('retains a symlinked candidate and a root whose marker is a symlink', () => {
    const tmpRoot = root();
    const noOpenLsof = makeLsof(tmpRoot);
    const elsewhere = path.join(tmpRoot, 'elsewhere');
    mkdirSync(elsewhere);
    const target = run(tmpRoot, ['create']);
    makeOld(target);
    const link = path.join(tmpRoot, 'mai-plan-review-pass.linked');
    symlinkSync(target, link, 'dir');

    const markerLinked = path.join(tmpRoot, 'mai-plan-review-pass.markerlink');
    mkdirSync(markerLinked);
    const realMarker = path.join(elsewhere, 'marker');
    writeFileSync(realMarker, `version=1\nuid=${process.getuid?.() ?? 0}\ncreated_at=2026-01-01T00:00:00Z\n`);
    symlinkSync(realMarker, path.join(markerLinked, MARKER), 'file');
    makeOld(markerLinked);

    // The genuine root is removed through its own direct-child path; the
    // symlink candidate and the symlinked-marker root are retained.
    run(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(markerLinked)).toBe(true);
    expect(existsSync(realMarker)).toBe(true);
  });

  it('renames before deleting and retains when the rename cannot happen', () => {
    if (!POSIX || process.getuid?.() === 0) return;
    const tmpRoot = root();
    const noOpenLsof = makeLsof(tmpRoot);
    const managed = run(tmpRoot, ['create']);
    makeOld(managed);
    chmodSync(tmpRoot, 0o500);
    try {
      const result = tryRun(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('rename failed');
      expect(existsSync(managed)).toBe(true);
    } finally {
      chmodSync(tmpRoot, 0o700);
    }
    run(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(existsSync(managed)).toBe(false);
    expect(readdirSync(tmpRoot).filter((name) => name.startsWith('.mai-review-tombstone.'))).toHaveLength(0);
  });

  it('cleanup exits nonzero when the managed root was retained', () => {
    if (!POSIX || process.getuid?.() === 0) return;
    const tmpRoot = root();
    const managed = run(tmpRoot, ['create']);
    chmodSync(tmpRoot, 0o500);
    try {
      const result = tryRun(tmpRoot, ['cleanup', managed]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('rename failed');
      expect(result.stderr).toContain('cleanup did not remove the managed root');
      expect(existsSync(managed)).toBe(true);
    } finally {
      chmodSync(tmpRoot, 0o700);
    }
    expect(run(tmpRoot, ['cleanup', managed])).toContain('removed:');
  });

  it('a removal that fails after the rename retains with a reason and the tombstone is reclaimed next prune', () => {
    if (!POSIX || process.getuid?.() === 0) return;
    const tmpRoot = root();
    const noOpenLsof = makeLsof(tmpRoot);
    const managed = run(tmpRoot, ['create']);
    const sealed = path.join(managed, 'tmp', 'sealed');
    mkdirSync(sealed);
    writeFileSync(path.join(sealed, 'inner'), 'x');
    makeOld(managed);
    chmodSync(sealed, 0o500); // entries inside cannot be unlinked, so rm fails after the rename
    const first = tryRun(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('removal failed after rename');
    const tombstones = readdirSync(tmpRoot).filter((name) => name.startsWith('.mai-review-tombstone.'));
    expect(tombstones).toHaveLength(1);
    chmodSync(path.join(tmpRoot, tombstones[0], 'tmp', 'sealed'), 0o700);
    const second = tryRun(tmpRoot, ['prune', '--days', '7'], { MAI_REVIEW_LSOF: noOpenLsof });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('reclaimed:');
    expect(readdirSync(tmpRoot).filter((name) => name.startsWith('.mai-review-tombstone.'))).toHaveLength(0);
    expect(existsSync(managed)).toBe(false);
  });

  it('Windows: an old root nobody holds open is removed (the probe reports an empty result as JSON)', () => {
    if (process.platform !== 'win32') return;
    const tmpRoot = root();
    const managed = run(tmpRoot, ['create']);
    writeFileSync(path.join(managed, 'quiet.txt'), 'x');
    makeOld(managed);
    const result = tryRun(tmpRoot, ['prune', '--days', '7']);
    expect(result.status).toBe(0);
    expect(result.stdout, result.stderr).toContain('removed:');
    expect(existsSync(managed)).toBe(false);
  });

  it('containment casefolds on Windows only and resolves case through the real path', () => {
    const probe = execFileSync(process.execPath, ['--input-type=module', '-e', [
      `import { samePath, parseMarker } from ${JSON.stringify(pathToFileURL(HELPER).href)};`,
      'console.log(JSON.stringify([',
      "  samePath('C:\\\\Temp\\\\A', 'c:\\\\temp\\\\a', 'win32'),",
      "  samePath('/tmp/A', '/tmp/a', 'linux'),",
      "  samePath('/tmp/a', '/tmp/a', 'darwin'),",
      "  parseMarker('version=1\\nuid=7\\nnew=x\\n'),",
      ']));',
    ].join('\n')], { encoding: 'utf8' });
    expect(JSON.parse(probe)).toEqual([true, false, true, { version: '1', uid: '7', new: 'x' }]);

    if (process.platform !== 'darwin') return;
    const tmpRoot = root();
    const scratch = run(tmpRoot, ['create']);
    const swapped = path.join(path.dirname(scratch).toUpperCase(), path.basename(scratch));
    if (!existsSync(swapped)) return; // a case-sensitive volume
    expect(run(tmpRoot, ['cleanup', swapped])).toContain('removed:');
    expect(existsSync(scratch)).toBe(false);
  });

  it('ships a template LaunchAgent that the installer renders', () => {
    if (process.platform !== 'darwin') return;
    expect(execFileSync('plutil', ['-lint', PLIST], { encoding: 'utf8' })).toContain('OK');
    const xml = readFileSync(PLIST, 'utf8');
    expect(xml).toContain('com.mai.review-tmp-janitor');
    expect(plistArgv(PLIST)).toEqual(PLIST_TEMPLATE_ARGV);
    expect(xml).not.toContain('/bin/zsh');
    expect(xml).not.toContain('<string>-c</string>');
    expect(xml).not.toContain('--root');
    expect(xml).not.toContain('--include-legacy');
    expect(xml).not.toContain('StandardOutPath');
    expect(xml).not.toContain('StandardErrorPath');
    expect(xml).toContain('<key>RunAtLoad</key><true/>');
    expect(xml).toContain('<key>Hour</key><integer>5</integer>');
    const backupXml = readFileSync(BACKUP_PLIST, 'utf8');
    expect(backupXml).not.toContain('/tmp/mai-brain-backup.log');
  });

  it('renders absolute metacharacter node and helper paths into the installed plist', () => {
    if (process.platform !== 'darwin') return;
    const tmpRoot = root();
    const nodeDir = path.join(tmpRoot, 'no de&<bin');
    mkdirSync(nodeDir);
    const fakeNode = path.join(nodeDir, 'node');
    writeFileSync(fakeNode, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(fakeNode, 0o700);
    const skillScripts = path.join(tmpRoot, 'help er&<copy', 'scripts');
    mkdirSync(skillScripts, { recursive: true });
    for (const name of ['install-janitor.sh', 'review-scratch.mjs', 'com.mai.review-tmp-janitor.plist']) {
      copyFileSync(path.join(SCRIPTS_DIR, name), path.join(skillScripts, name));
    }
    const { env, agents } = janitorFixture(tmpRoot, { realPlutil: true });
    env.PATH = `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`;

    execFileSync('bash', [path.join(skillScripts, 'install-janitor.sh'), 'install'], { env });
    const installed = path.join(agents, 'com.mai.review-tmp-janitor.plist');
    expect(execFileSync('plutil', ['-lint', installed], { encoding: 'utf8' })).toContain('OK');
    expect(plistArgv(installed)).toEqual([
      fakeNode, realpathSync(path.join(skillScripts, 'review-scratch.mjs')), 'prune', '--days', '7',
    ]);
    expect(plistArgv(PLIST)).toEqual(PLIST_TEMPLATE_ARGV);
  });

  it('dies before staging when node or the helper is missing', () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const { env, agents } = janitorFixture(tmpRoot);
    const emptyBin = path.join(tmpRoot, 'empty-bin');
    mkdirSync(emptyBin);
    mkdirSync(agents, { recursive: true });

    const noNode = spawnSync('bash', [INSTALLER, 'install'], {
      encoding: 'utf8',
      env: { ...env, PATH: `${emptyBin}:/usr/bin:/bin` },
    });
    expect(noNode.status).not.toBe(0);
    expect(noNode.stderr).toContain('node is not on PATH');
    expect(readdirSync(agents)).toHaveLength(0);

    const bare = path.join(tmpRoot, 'bare-scripts');
    mkdirSync(bare);
    copyFileSync(INSTALLER, path.join(bare, 'install-janitor.sh'));
    copyFileSync(PLIST, path.join(bare, 'com.mai.review-tmp-janitor.plist'));
    const noHelper = spawnSync('bash', [path.join(bare, 'install-janitor.sh'), 'install'], { encoding: 'utf8', env });
    expect(noHelper.status).not.toBe(0);
    expect(noHelper.stderr).toContain('canonical helper is missing');
    expect(readdirSync(agents)).toHaveLength(0);
  });

  it('refuses non-macOS hosts and points at the Windows installer', () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const { env } = janitorFixture(tmpRoot);
    const result = spawnSync('bash', [INSTALLER, 'install'], {
      encoding: 'utf8',
      env: { ...env, MAI_REVIEW_PLATFORM: 'Linux' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('install-maintenance.ps1 -Job ReviewCleanup -Action Install');
  });

  it('installs, reports and uninstalls with an isolated launchctl', () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const { env, agents } = janitorFixture(tmpRoot);

    execFileSync('bash', [INSTALLER, 'install'], { env });
    const installed = path.join(agents, 'com.mai.review-tmp-janitor.plist');
    expect(existsSync(installed)).toBe(true);
    execFileSync('bash', [INSTALLER, 'status'], { env });
    execFileSync('bash', [INSTALLER, 'uninstall'], { env });
    expect(existsSync(installed)).toBe(false);
  });

  it('restores the prior loaded janitor when an update fails', () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const state = path.join(tmpRoot, 'state');
    const log = path.join(tmpRoot, 'calls');
    const { env, agents } = janitorFixture(tmpRoot, {
      launchctlBody: `#!/bin/sh
set -eu
state=${JSON.stringify(state)}
echo "$1" >> ${JSON.stringify(log)}
case "$1" in
  print) test -f "$state/loaded" ;;
  bootout) rm -f "$state/loaded" ;;
  bootstrap)
    if test -f "$state/fail-once"; then rm "$state/fail-once"; exit 55; fi
    touch "$state/loaded"
    ;;
  kickstart) test -f "$state/loaded" ;;
esac
`,
    });
    mkdirSync(agents, { recursive: true });
    const installed = path.join(agents, 'com.mai.review-tmp-janitor.plist');
    writeFileSync(installed, 'prior-plist');
    writeFileSync(path.join(state, 'loaded'), '1');
    writeFileSync(path.join(state, 'fail-once'), '1');

    const result = spawnSync('bash', [INSTALLER, 'install'], { encoding: 'utf8', env });
    expect(result.status).not.toBe(0);
    expect(readFileSync(installed, 'utf8')).toBe('prior-plist');
    expect(existsSync(path.join(state, 'loaded'))).toBe(true);
    expect(readFileSync(log, 'utf8').match(/bootstrap/g)).toHaveLength(2);
  });

  it('leaves the prior job and plist untouched when launchctl status fails', () => {
    if (!POSIX) return;
    const tmpRoot = root();
    const log = path.join(tmpRoot, 'calls');
    const { env, agents } = janitorFixture(tmpRoot, {
      launchctlBody: `#!/bin/sh
echo "$1" >> ${JSON.stringify(log)}
if test "$1" = print; then echo operational-failure >&2; exit 2; fi
exit 99
`,
    });
    mkdirSync(agents, { recursive: true });
    const installed = path.join(agents, 'com.mai.review-tmp-janitor.plist');
    writeFileSync(installed, 'prior-plist');

    const result = spawnSync('bash', [INSTALLER, 'install'], { encoding: 'utf8', env });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not determine whether the prior janitor is loaded');
    expect(readFileSync(installed, 'utf8')).toBe('prior-plist');
    expect(readFileSync(log, 'utf8').trim()).toBe('print');
  });
});
