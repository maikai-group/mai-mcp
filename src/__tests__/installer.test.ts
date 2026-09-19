/** Plan 15 Task 5: the thin installer. Fully offline — a stub git executable and npm-cli script
 * log argv AND cwd to a file, the delegated checkout bin is a stub that
 * records its argv/cwd and exits with a configured status, and HOME points at
 * a temp dir so DEFAULT_HOME never touches the operator's machine. The packed
 * case runs the REAL npm pack, extracts the tarball, and executes the packed
 * bin through the same stubs. */
import { describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  executableExtensions as platformExecutableExtensions,
  findExecutable as platformFindExecutable,
} from '../platform/commands.js';
import { installFakeTool } from './support/fake-tool.js';

const WINDOWS = process.platform === 'win32';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INSTALLER_BIN = path.join(REPO_ROOT, 'installer', 'bin', 'mai-mcp.mjs');
const PUBLIC_REPO = 'https://github.com/maikai-group/mai-mcp.git';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface InstallerModule {
  PUBLIC_REPO: string;
  DEFAULT_HOME: string;
  expandHomePath(value: string, home?: string): string;
  normalizeOriginUrl(url: string): string;
  parseInstallerArgs(argv: string[]): Record<string, unknown>;
  executableExtensions(spec: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): readonly string[];
  findExecutable(
    name: string,
    partial?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv },
  ): string | null;
  resolveNpmCli(options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
  }): string;
  runNpm(
    npmCli: string,
    npmArgs: readonly string[],
    options: { cwd?: string; timeoutMs: number; stdio?: 'inherit' },
  ): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
  validatePromptedInstallPath(value: string): string;
}
function isInstallerModule(m: unknown): m is InstallerModule {
  return (
    isRecord(m) &&
    typeof m.PUBLIC_REPO === 'string' &&
    typeof m.expandHomePath === 'function' &&
    typeof m.normalizeOriginUrl === 'function' &&
    typeof m.parseInstallerArgs === 'function' &&
    typeof m.executableExtensions === 'function' &&
    typeof m.findExecutable === 'function' &&
    typeof m.resolveNpmCli === 'function' &&
    typeof m.runNpm === 'function' &&
    typeof m.validatePromptedInstallPath === 'function'
  );
}
async function loadInstaller(): Promise<InstallerModule> {
  const specifier = new URL('../../installer/bin/mai-mcp.mjs', import.meta.url).href;
  const loaded: unknown = await import(specifier);
  if (!isInstallerModule(loaded)) throw new Error('installer exports are incomplete');
  return loaded;
}

const DELEGATE_STUB = `const fs = require('node:fs');
fs.appendFileSync(process.env.INSTALLER_LOG, JSON.stringify({
  kind: 'delegate', argv: process.argv.slice(2), cwd: process.cwd(),
}) + '\\n');
process.exit(Number(process.env.DELEGATE_EXIT ?? '0'));
`;

const NPM_CLI_STUB = `const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALLER_LOG, process.cwd() + '|npm ' + argv.join(' ') + '\\n');
fs.appendFileSync(process.env.INSTALLER_LOG, JSON.stringify({
  kind: 'npm', executable: process.execPath, argv: process.argv.slice(1), cwd: process.cwd(),
}) + '\\n');
if (argv[0] === 'run' && argv[1] === 'build') {
  fs.mkdirSync(process.cwd() + '/build', { recursive: true });
  fs.copyFileSync(process.env.STUB_DELEGATE, process.cwd() + '/build/entry.js');
}
`;

interface World {
  binDir: string;
  home: string;
  consumer: string;
  log: string;
  delegateStubPath: string;
  npmCliPath: string;
}
function makeWorld(): World {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mai-installer-'));
  const binDir = path.join(root, 'stub-bin');
  const home = path.join(root, 'home');
  const consumer = path.join(root, 'consumer project');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  const log = path.join(root, 'calls.log');
  writeFileSync(log, '');
  const delegateStubPath = path.join(root, 'delegate-entry.js');
  writeFileSync(delegateStubPath, DELEGATE_STUB);
  const npmCliPath = path.join(root, 'npm-cli.js');
  writeFileSync(npmCliPath, NPM_CLI_STUB);

  // Installed by the shared helper, never written as a `#!/bin/sh` file:
  // Windows cannot execute one, so the stub becomes a shim + Git Bash body
  // there (support/fake-tool.ts) and stays a plain script on POSIX.
  installFakeTool(
    binDir,
    'git',
    `# Git for Windows bash reports the temp dir as /tmp; log the native cwd there.
here=$PWD; if command -v cygpath >/dev/null 2>&1; then here=$(cygpath -w "$PWD"); fi
echo "$here|git $*" >> "$INSTALLER_LOG"
case "$1" in
  --version) exit 0 ;;
  clone)
    URL="$4"; TARGET="$5"
    if [ "\${STUB_CLONE_FAIL:-}" = "1" ]; then mkdir -p "$TARGET"; echo partial > "$TARGET/partial"; exit 1; fi
    mkdir -p "$TARGET/.git"
    printf '%s\\n' "$URL" > "$TARGET/.git/origin-url"
    exit 0 ;;
  -C)
    DIR="$2"; shift 2
    case "$1" in
      remote) cat "$DIR/.git/origin-url" 2>/dev/null || echo unknown; exit 0 ;;
      pull) exit "\${STUB_PULL_FAIL:-0}" ;;
    esac
    exit 0 ;;
esac
exit 0
`
  );
  return { binDir, home, consumer, log, delegateStubPath, npmCliPath };
}

/** The host variables a child node and the compiled fake-tool shim need on
 * Windows (and NOTHING else — no NODE_OPTIONS from the vitest worker, no real
 * MAI_* settings): every key is named, so the stub world stays controlled and
 * the built env carries exactly one PATH, which two names differing only in
 * case would make ambiguous to Windows. Empty on POSIX. */
function windowsSystemEnv(): NodeJS.ProcessEnv {
  if (!WINDOWS) return {};
  const out: NodeJS.ProcessEnv = {};
  for (const key of [
    'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
    'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'NUMBER_OF_PROCESSORS',
  ]) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}
async function runInstallerBin(
  world: World,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  bin: string = INSTALLER_BIN
): Promise<SpawnResult> {
  try {
    // Stubs FIRST (shadowing real git/npm), then the system entries the stub
    // scripts need to reach mkdir/cat/printf: /usr/bin:/bin on POSIX, the
    // host's own PATH on Windows (where those live inside the Git
    // installation). Still offline: every git/npm resolution hits the stubs.
    const systemPath = WINDOWS ? (process.env.PATH ?? '') : `/usr/bin${path.delimiter}/bin`;
    const env: NodeJS.ProcessEnv = {
      ...windowsSystemEnv(),
      PATH: [world.binDir, systemPath].filter((part) => part.length > 0).join(path.delimiter),
      HOME: world.home,
      // homedir() reads USERPROFILE on Windows and HOME elsewhere (libuv), and
      // the installer's DEFAULT_HOME must land inside the temp world on both.
      USERPROFILE: world.home,
      INSTALLER_LOG: world.log,
      STUB_DELEGATE: world.delegateStubPath,
      MAI_NPM_CLI: world.npmCliPath,
      ...extraEnv,
    };
    const r = await run(process.execPath, [bin, ...args], {
      cwd: world.consumer,
      env,
      timeout: 60_000,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    if (typeof err !== 'object' || err === null) throw err;
    if ('killed' in err && err.killed === true) throw new Error(`installer HUNG: ${args.join(' ')}`);
    const code = 'code' in err && typeof err.code === 'number' ? err.code : -1;
    const stdout = 'stdout' in err && typeof err.stdout === 'string' ? err.stdout : '';
    const stderr = 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : '';
    return { code, stdout, stderr };
  }
}

/** macOS tmp dirs are symlinked (/var → /private/var); compare realpaths. On
 * Windows the git stub runs under Git Bash, which reports `$PWD` as an MSYS
 * path (`/c/…`) — restore the native shape first, and compare case-insensitively
 * as that filesystem does. */
function samePath(a: string, b: string): boolean {
  const canonical = (p: string): string => {
    const msys = /^\/([A-Za-z])\/(.*)$/u.exec(p);
    const native = WINDOWS && msys !== null ? `${msys[1]}:\\${msys[2].replace(/\//gu, '\\')}` : p;
    let resolved: string;
    try {
      resolved = realpathSync(native);
    } catch {
      resolved = native;
    }
    return WINDOWS ? resolved.toLowerCase() : resolved;
  };
  return canonical(a) === canonical(b);
}

/** One `<cwd>|<command>` stub log line: the cwd compares as a path (the stubs
 * report it in their own platform's shape), the command byte-for-byte. */
function expectLoggedCall(line: string | undefined, cwd: string, command: string): void {
  const separator = (line ?? '').indexOf('|');
  expect(separator, line).toBeGreaterThan(0);
  expect(samePath((line ?? '').slice(0, separator), cwd), `${line} vs cwd ${cwd}`).toBe(true);
  expect((line ?? '').slice(separator + 1)).toBe(command);
}

function logLines(world: World): string[] {
  return readFileSync(world.log, 'utf8').split('\n').filter((l) => l.length > 0);
}
interface DelegateCall {
  argv: string[];
  cwd: string;
}

interface NpmCall {
  executable: string;
  argv: string[];
  cwd: string;
}

function npmCalls(world: World): NpmCall[] {
  const out: NpmCall[] = [];
  for (const line of logLines(world)) {
    if (!line.startsWith('{')) continue;
    const parsed: unknown = JSON.parse(line);
    if (
      isRecord(parsed) &&
      parsed.kind === 'npm' &&
      typeof parsed.executable === 'string' &&
      Array.isArray(parsed.argv) &&
      typeof parsed.cwd === 'string'
    ) {
      out.push({
        executable: parsed.executable,
        argv: parsed.argv.filter((arg): arg is string => typeof arg === 'string'),
        cwd: parsed.cwd,
      });
    }
  }
  return out;
}

function delegateCalls(world: World): DelegateCall[] {
  const out: DelegateCall[] = [];
  for (const line of logLines(world)) {
    if (!line.startsWith('{')) continue;
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed) && parsed.kind === 'delegate' && Array.isArray(parsed.argv) && typeof parsed.cwd === 'string') {
      out.push({ argv: parsed.argv.filter((a): a is string => typeof a === 'string'), cwd: parsed.cwd });
    }
  }
  return out;
}

/** Pre-create a valid existing clone (matching origin) with a built entry. */
function seedExistingClone(world: World, target: string, origin: string = PUBLIC_REPO, withBuild = true): void {
  mkdirSync(path.join(target, '.git'), { recursive: true });
  writeFileSync(path.join(target, '.git', 'origin-url'), `${origin}\n`);
  if (withBuild) {
    mkdirSync(path.join(target, 'build'), { recursive: true });
    writeFileSync(path.join(target, 'build', 'entry.js'), DELEGATE_STUB);
  }
}

describe('exported helpers', () => {
  it('expandHomePath handles ~, ~/x, absolute, and rejects ~user', async () => {
    const mod = await loadInstaller();
    expect(mod.expandHomePath('~', '/h')).toBe('/h');
    expect(mod.expandHomePath('~/sub', '/h')).toBe(path.join('/h', 'sub'));
    expect(mod.expandHomePath('/abs/x', '/h')).toBe('/abs/x');
    expect(() => mod.expandHomePath('~root/x', '/h')).toThrow(/~user/);
  });

  it('normalizeOriginUrl equates .git and trailing-slash variants', async () => {
    const mod = await loadInstaller();
    expect(mod.normalizeOriginUrl('https://github.com/maikai-group/mai-mcp.git')).toBe(
      mod.normalizeOriginUrl('https://github.com/Maikai-Group/mai-mcp/')
    );
    expect(mod.normalizeOriginUrl('https://github.com/evil/mai-mcp.git')).not.toBe(
      mod.normalizeOriginUrl(PUBLIC_REPO)
    );
  });

  it('parseInstallerArgs: setup flags strict, -- forwarded byte-for-byte, passthrough untouched', async () => {
    const mod = await loadInstaller();
    expect(mod.parseInstallerArgs([])).toEqual({ mode: 'help' });
    expect(mod.parseInstallerArgs(['--version'])).toEqual({ mode: 'version' });
    const setup = mod.parseInstallerArgs(['setup', '--dir', '/x', '--yes', '--update', '--', '--llm', 'none']);
    expect(setup).toMatchObject({ mode: 'setup', dir: '/x', yes: true, update: true, forwarded: ['--llm', 'none'] });
    expect(() => mod.parseInstallerArgs(['setup', '--bogus'])).toThrow(/unknown installer flag/);
    const pass = mod.parseInstallerArgs(['verify', 'my-slug', '--smoke']);
    expect(pass).toMatchObject({ mode: 'passthrough', passthrough: ['verify', 'my-slug', '--smoke'] });
  });
});

describe('Plan 32a portable installer cases', () => {
  it('I01 — matches platform lookup for Windows .EXE and .CMD executables', async () => {
    const mod = await loadInstaller();
    const root = mkdtempSync(path.join(os.tmpdir(), 'mai-installer-finder-'));
    const exe = path.join(root, 'git.EXE');
    const cmd = path.join(root, 'docker.CMD');
    writeFileSync(exe, 'exe');
    writeFileSync(cmd, 'cmd');
    const spec = { platform: 'win32' as const, env: { PATH: root, PATHEXT: '.EXE;.CMD' } };
    expect(mod.findExecutable('git', spec)).toBe(platformFindExecutable('git', spec));
    expect(mod.findExecutable('docker', spec)).toBe(platformFindExecutable('docker', spec));
    expect(mod.findExecutable('git', spec)).toBe(exe);
    expect(mod.findExecutable('docker', spec)).toBe(cmd);
  });

  it('I02 — matches platform PATHEXT normalization and case folding', async () => {
    const mod = await loadInstaller();
    const root = mkdtempSync(path.join(os.tmpdir(), 'mai-installer-pathext-'));
    const executable = path.join(root, 'tool.EXE');
    writeFileSync(executable, 'exe');
    const spec = { platform: 'win32' as const, env: { Pathext: '.exe;.EXE;.cmd;.CMD' } };
    expect(mod.executableExtensions(spec)).toEqual(platformExecutableExtensions(spec));
    expect(mod.executableExtensions(spec)).toEqual(['.exe', '.cmd']);
    expect(mod.findExecutable(executable, spec)).toBe(platformFindExecutable(executable, spec));
    expect(mod.findExecutable(executable, spec)).toBe(executable);
  });

  it('I03 — returns null when an executable is missing', async () => {
    const mod = await loadInstaller();
    const root = mkdtempSync(path.join(os.tmpdir(), 'mai-installer-missing-'));
    const spec = { platform: 'win32' as const, env: { PATH: root, PATHEXT: '.EXE;.CMD' } };
    expect(mod.findExecutable('missing', spec)).toBe(platformFindExecutable('missing', spec));
    expect(mod.findExecutable('missing', spec)).toBeNull();
  });

  it('I04 — normalizes and preserves an install path containing spaces', async () => {
    const world = makeWorld();
    const relative = 'brain with spaces';
    const target = path.resolve(world.consumer, relative);
    const result = await runInstallerBin(world, ['setup', '--yes', '--dir', relative]);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    const reported = result.stdout.trim().replace(/^mai-mcp home: /u, '');
    expect(path.isAbsolute(reported)).toBe(true);
    expect(samePath(reported, target)).toBe(true);
  });

  it('I05 — preserves an ampersand in the install path as argv data', async () => {
    const world = makeWorld();
    const target = path.join(world.home, 'brain&memory');
    const result = await runInstallerBin(world, ['setup', '--yes', '--dir', target]);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(target, '.git'))).toBe(true);
  });

  it('I06 — preserves parentheses and percent signs in the install path as argv data', async () => {
    const world = makeWorld();
    const target = path.join(world.home, 'brain(v1)%cache%');
    const result = await runInstallerBin(world, ['setup', '--yes', '--dir', target]);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(target, '.git'))).toBe(true);
  });

  it('I07 — preserves Unicode in the install path as argv data', async () => {
    const world = makeWorld();
    const target = path.join(world.home, '記憶-λ-雪');
    const result = await runInstallerBin(world, ['setup', '--yes', '--dir', target]);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(target, '.git'))).toBe(true);
  });

  it('I08 — preserves the caller cwd when delegating to the installed checkout', async () => {
    const world = makeWorld();
    const target = path.join(world.home, 'mai-mcp');
    seedExistingClone(world, target);
    const result = await runInstallerBin(world, ['verify', 'project-slug']);
    expect(result.code).toBe(0);
    const delegates = delegateCalls(world);
    expect(delegates).toHaveLength(1);
    expect(delegates[0].argv).toEqual(['verify', 'project-slug']);
    expect(samePath(delegates[0].cwd, world.consumer)).toBe(true);
  });

  it('I09 — reuses the cached checkout without reinstalling on a current rerun', async () => {
    const world = makeWorld();
    expect((await runInstallerBin(world, ['setup', '--yes'])).code).toBe(0);
    expect((await runInstallerBin(world, ['setup', '--yes'])).code).toBe(0);
    expect(npmCalls(world).map((call) => call.argv.slice(1))).toEqual([
      ['install'],
      ['run', 'build'],
    ]);
    expect(delegateCalls(world)).toHaveLength(2);
  });

  it('I10 — rejects newline and NUL in prompted paths without rejecting supported characters', async () => {
    const mod = await loadInstaller();
    expect(() => mod.validatePromptedInstallPath('brain\nother')).toThrow(/newline or NUL/);
    expect(() => mod.validatePromptedInstallPath('brain\0other')).toThrow(/newline or NUL/);
    expect(mod.validatePromptedInstallPath('space & (value)% 雪')).toBe('space & (value)% 雪');
  });

  it('I11 — invokes npm through process.execPath and npm-cli.js with verbatim argv', async () => {
    const mod = await loadInstaller();
    const root = mkdtempSync(path.join(os.tmpdir(), 'mai-installer-npm-route-'));
    const npmCli = path.join(root, 'npm-cli.js');
    writeFileSync(npmCli, '');
    const resolvedNpmCli = mod.resolveNpmCli({ env: { MAI_NPM_CLI: npmCli } });
    expect(resolvedNpmCli).toBe(npmCli);
    const npmArgs = ['run', 'build', '--', 'two words', 'a&b', '(x)%value%', '雪'];
    const spy = vi.mocked(spawnSync);
    spy.mockClear();
    const result = mod.runNpm(resolvedNpmCli, npmArgs, { cwd: root, timeoutMs: 2_000 });
    expect(result.status).toBe(0);
    const call = spy.mock.calls.at(-1);
    expect(call).toBeDefined();
    expect(call?.[0]).toBe(process.execPath);
    expect(call?.[1]).toEqual([resolvedNpmCli, ...npmArgs]);
    expect(call?.[2]).toMatchObject({ cwd: root, timeout: 2_000, shell: false });
  });

  it('I12 — refuses a .cmd-only npm layout instead of spawning the shim', async () => {
    const mod = await loadInstaller();
    const root = mkdtempSync(path.join(os.tmpdir(), 'mai-installer-cmd-only-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const npmCmd = path.join(bin, 'npm.CMD');
    writeFileSync(npmCmd, '@echo off\r\n');
    const fakeNode = path.join(bin, 'node.exe');
    writeFileSync(fakeNode, 'node');
    const env = { PATH: bin, PATHEXT: '.CMD' };
    expect(mod.findExecutable('npm', { platform: 'win32', env })).toBe(npmCmd);
    const spy = vi.mocked(spawnSync);
    spy.mockClear();
    expect(() => mod.resolveNpmCli({ platform: 'win32', env, execPath: fakeNode })).toThrow(
      `npm-cli.js not found beside ${fakeNode}; install Node from nodejs.org or set MAI_NPM_CLI to its path`,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('installer runs (stub binaries, offline)', () => {
  it('--help and --version answer locally with zero mutation', async () => {
    const world = makeWorld();
    const help = await runInstallerBin(world, ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage: npx mai-mcp setup');
    const version = await runInstallerBin(world, ['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe('1.0.0');
    expect(logLines(world)).toEqual([]); // no git/npm call at all
    expect(existsSync(path.join(world.home, 'mai-mcp'))).toBe(false);
  });

  it('fresh setup: exact clone→install→build→delegate sequence, cwd split, forwarding, home print', async () => {
    const world = makeWorld();
    const target = path.join(world.home, 'mai-mcp');
    const r = await runInstallerBin(world, ['setup', '--yes', '--', '--harness', 'codex', '--no-skills']);
    expect(r.code).toBe(0);

    const lines = logLines(world).filter((l) => !l.startsWith('{'));
    expect(lines[0]).toContain('|git --version');
    expectLoggedCall(lines[1], world.home, `git clone --depth 1 ${PUBLIC_REPO} ${target}`);
    expectLoggedCall(lines[2], target, 'npm install');
    expectLoggedCall(lines[3], target, 'npm run build');

    const delegates = delegateCalls(world);
    expect(delegates).toHaveLength(1);
    expect(delegates[0].argv).toEqual(['setup', '--yes', '--harness', 'codex', '--no-skills']);
    expect(samePath(delegates[0].cwd, world.consumer)).toBe(true); // the CALLER's repo, not the checkout
    expect(r.stdout).toContain(`mai-mcp home: ${target}`);
  });

  it('--dir expands ~/ against HOME and never becomes the consumer root', async () => {
    const world = makeWorld();
    const r = await runInstallerBin(world, ['setup', '--yes', '--dir', '~/elsewhere/brain']);
    expect(r.code).toBe(0);
    const target = path.join(world.home, 'elsewhere', 'brain');
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    expect(samePath(delegateCalls(world)[0].cwd, world.consumer)).toBe(true);
  });

  it('accepts checkout paths with spaces and shell metacharacters as opaque arguments', async () => {
    const world = makeWorld();
    const target = path.join(world.home, "brain ' $(still-data)");
    const r = await runInstallerBin(world, ['setup', '--yes', '--dir', target]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    expect(samePath(delegateCalls(world)[0].cwd, world.consumer)).toBe(true);
  });

  it('~user is refused before any mutation', async () => {
    const world = makeWorld();
    const r = await runInstallerBin(world, ['setup', '--yes', '--dir', '~root/x']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('~user');
    expect(logLines(world).some((l) => l.includes('git clone'))).toBe(false);
  });

  it('an unknown installer flag fails with usage before any call', async () => {
    const world = makeWorld();
    const r = await runInstallerBin(world, ['setup', '--force-everything']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown installer flag');
    expect(logLines(world)).toEqual([]);
  });

  it('non-TTY without --dir/--yes refuses', async () => {
    const world = makeWorld();
    const r = await runInstallerBin(world, ['setup']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--yes');
    expect(logLines(world).some((l) => l.includes('clone'))).toBe(false);
  });

  it('a failed clone removes only the partial target this invocation created', async () => {
    const world = makeWorld();
    const target = path.join(world.home, 'mai-mcp');
    const r = await runInstallerBin(world, ['setup', '--yes'], { STUB_CLONE_FAIL: '1' });
    expect(r.code).toBe(1);
    expect(existsSync(target)).toBe(false); // partial clone cleaned

    // A PRE-EXISTING foreign directory is never removed.
    const world2 = makeWorld();
    const pre = path.join(world2.home, 'mai-mcp');
    mkdirSync(pre, { recursive: true });
    writeFileSync(path.join(pre, 'precious.txt'), 'keep me\n');
    const r2 = await runInstallerBin(world2, ['setup', '--yes']);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain('not a git checkout');
    expect(readFileSync(path.join(pre, 'precious.txt'), 'utf8')).toBe('keep me\n');
  });

  it('a foreign origin stops before install/build; a matching origin variant is accepted', async () => {
    const world = makeWorld();
    const target = path.join(world.home, 'mai-mcp');
    seedExistingClone(world, target, 'https://github.com/evil/other.git');
    const r = await runInstallerBin(world, ['setup', '--yes']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('different repository');
    expect(logLines(world).some((l) => l.includes('npm'))).toBe(false);

    const world2 = makeWorld();
    const target2 = path.join(world2.home, 'mai-mcp');
    seedExistingClone(world2, target2, 'https://github.com/Maikai-Group/mai-mcp/');
    const r2 = await runInstallerBin(world2, ['setup', '--yes']);
    expect(r2.code).toBe(0);
  });

  it('an existing current build skips install/build; a missing build repairs; only --update pulls', async () => {
    const current = makeWorld();
    seedExistingClone(current, path.join(current.home, 'mai-mcp'));
    await runInstallerBin(current, ['setup', '--yes']);
    const currentLines = logLines(current);
    expect(currentLines.some((l) => l.includes('npm install'))).toBe(false);
    expect(currentLines.some((l) => l.includes('pull'))).toBe(false);
    expect(delegateCalls(current)).toHaveLength(1);

    const stale = makeWorld();
    seedExistingClone(stale, path.join(stale.home, 'mai-mcp'), PUBLIC_REPO, false);
    await runInstallerBin(stale, ['setup', '--yes']);
    expect(logLines(stale).some((l) => l.includes('npm install'))).toBe(true);
    expect(logLines(stale).some((l) => l.includes('npm run build'))).toBe(true);

    const updated = makeWorld();
    seedExistingClone(updated, path.join(updated.home, 'mai-mcp'));
    await runInstallerBin(updated, ['setup', '--yes', '--update']);
    const updatedLines = logLines(updated);
    expect(updatedLines.some((l) => l.includes('pull --ff-only'))).toBe(true);
    expect(updatedLines.some((l) => l.includes('npm run build'))).toBe(true);
  });

  it('propagates the delegated exit status exactly and withholds the home line on failure', async () => {
    const world = makeWorld();
    seedExistingClone(world, path.join(world.home, 'mai-mcp'));
    const r = await runInstallerBin(world, ['setup', '--yes'], { DELEGATE_EXIT: '3' });
    expect(r.code).toBe(3);
    expect(r.stdout).not.toContain('mai-mcp home:');
  });

  it('pass-through verbs require a verified checkout and keep the consumer cwd', async () => {
    const missing = makeWorld();
    const r = await runInstallerBin(missing, ['verify', 'my-slug']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('npx mai-mcp setup');

    const world = makeWorld();
    seedExistingClone(world, path.join(world.home, 'mai-mcp'));
    const ok = await runInstallerBin(world, ['skills', 'status', '--codex-scope', 'repo']);
    expect(ok.code).toBe(0);
    const delegates = delegateCalls(world);
    expect(delegates[0].argv).toEqual(['skills', 'status', '--codex-scope', 'repo']);
    expect(samePath(delegates[0].cwd, world.consumer)).toBe(true);
  });

  it('emits no environment dumps or secrets', async () => {
    const world = makeWorld();
    const r = await runInstallerBin(world, ['setup', '--yes']);
    const all = r.stdout + r.stderr;
    expect(all).not.toContain('PATH=');
    expect(all).not.toContain('INSTALLER_LOG');
    expect(all).not.toContain('postgres:postgres');
  });
});

describe('packaging', () => {
  /** npm through node + npm-cli.js — the installer's OWN route (resolveNpmCli),
   * and the only portable one: `npm` on a Windows PATH is a .cmd that Node
   * refuses to execute without a shell. */
  async function runNpmCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const npmCli = (await loadInstaller()).resolveNpmCli();
    return run(process.execPath, [npmCli, ...args], {
      cwd,
      env: { ...process.env },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  it('npm pack --dry-run lists exactly the four published files', async () => {
    const r = await runNpmCli(['pack', '--dry-run', '--json', './installer'], REPO_ROOT);
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed) || !isRecord(parsed[0]) || !Array.isArray(parsed[0].files)) {
      throw new Error('unexpected npm pack output');
    }
    const files = parsed[0].files
      .map((f: unknown) => (isRecord(f) && typeof f.path === 'string' ? f.path : ''))
      .sort();
    expect(files).toEqual(['LICENSE', 'README.md', 'bin/mai-mcp.mjs', 'package.json']);
  });

  it('executes the packed installer through stub git and npm binaries', async () => {
    const packDir = mkdtempSync(path.join(os.tmpdir(), 'mai-installer-pack-'));
    const packed = await runNpmCli(['pack', '--json', path.join(REPO_ROOT, 'installer')], packDir);
    const meta: unknown = JSON.parse(packed.stdout);
    if (!Array.isArray(meta) || !isRecord(meta[0]) || typeof meta[0].filename !== 'string') {
      throw new Error('unexpected npm pack output');
    }
    await run('tar', ['-xzf', meta[0].filename], { cwd: packDir, timeout: 60_000 });
    const packedBin = path.join(packDir, 'package', 'bin', 'mai-mcp.mjs');
    expect(existsSync(packedBin)).toBe(true);

    const world = makeWorld();
    const target = path.join(world.home, 'mai-mcp');
    const r = await runInstallerBin(world, ['setup', '--yes'], { DELEGATE_EXIT: '2' }, packedBin);
    expect(r.code).toBe(2); // exact delegated status through the packed bin
    const lines = logLines(world).filter((l) => !l.startsWith('{'));
    expectLoggedCall(lines[1], world.home, `git clone --depth 1 ${PUBLIC_REPO} ${target}`);
    expectLoggedCall(lines[2], target, 'npm install');
    expectLoggedCall(lines[3], target, 'npm run build');
    expect(samePath(delegateCalls(world)[0].cwd, world.consumer)).toBe(true);

    const help = await runInstallerBin(world, ['--help'], {}, packedBin);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage: npx mai-mcp setup');
    expect(help.stdout).not.toContain('/Users/');
    expect(help.stdout).not.toContain('postgres');
  });
});
