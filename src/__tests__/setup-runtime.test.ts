import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSetupIO } from '../scripts/setup.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ARTIFACTS = ['setup-runtime.generated.mjs', 'setup-runtime.generated.d.mts', 'setup-runtime.LICENSE.txt'];
const DEPS = ['cross-spawn', 'isexe', 'path-key', 'shebang-command', 'shebang-regex', 'which'];
const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mai-setup-runtime-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function copy(root: string, relative: string): void {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  cpSync(path.join(REPO_ROOT, relative), path.join(root, relative));
}
function generatorFixture(): string {
  const root = temporary();
  for (const relative of ['package.json', 'package-lock.json', 'scripts/setup-runtime.mjs',
    'src/scripts/setup-runtime-entry.ts', 'src/scripts/database-setup.ts',
    'src/platform/commands.ts', 'src/platform/processes.ts']) copy(root, relative);
  mkdirSync(path.join(root, 'node_modules'));
  // Generator-only dependency. Cold route fixtures below contain no symlinks or dependencies.
  symlinkSync(path.join(REPO_ROOT, 'node_modules', 'esbuild'), path.join(root, 'node_modules', 'esbuild'), 'junction');
  for (const name of DEPS) cpSync(path.join(REPO_ROOT, 'node_modules', name), path.join(root, 'node_modules', name), { recursive: true });
  mkdirSync(path.join(root, 'build', 'scripts'), { recursive: true });
  return root;
}
function generate(root: string, mode: string) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'setup-runtime.mjs'), mode],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } });
  if (result.error) throw result.error;
  return result;
}
function coldFixture(route: string): string {
  const root = temporary();
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'empty-bin'));
  if (route === 'source') {
    copy(root, 'src/scripts/setup.ts');
    for (const name of ARTIFACTS) copy(root, `src/scripts/${name}`);
  } else {
    copy(root, 'build/entry.js');
    copy(root, 'build/automation-command.js');
    copy(root, 'build/scripts/setup.js');
    for (const name of ARTIFACTS) copy(root, `build/scripts/${name}`);
  }
  expect(existsSync(path.join(root, 'node_modules'))).toBe(false);
  if (route === 'source') expect(existsSync(path.join(root, 'build'))).toBe(false);
  return root;
}
function runRoute(root: string, route: string, args: string[]) {
  const argv = route === 'source'
    ? [path.join(root, 'src/scripts/setup.ts'), ...args]
    : [path.join(root, 'build/entry.js'), 'setup', ...args];
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 10_000,
    env: { PATH: path.join(root, 'empty-bin'), SystemRoot: process.env.SystemRoot, TMPDIR: root, TMP: root, TEMP: root } });
  if (result.error) throw result.error;
  return result;
}

describe('committed setup runtime', () => {
  it('generates deterministically, retains notices, and copies exact checked bytes', () => {
    const root = generatorFixture();
    expect(generate(root, '--write').status).toBe(0);
    const original = ARTIFACTS.map(name => readFileSync(path.join(root, 'src/scripts', name), 'utf8'));
    expect(generate(root, '--write').status).toBe(0);
    expect(ARTIFACTS.map(name => readFileSync(path.join(root, 'src/scripts', name), 'utf8'))).toEqual(original);
    expect(generate(root, '--check').status).toBe(0);
    expect(generate(root, '--copy').status).toBe(0);
    expect(ARTIFACTS.map(name => readFileSync(path.join(root, 'build/scripts', name), 'utf8'))).toEqual(original);
    for (const name of DEPS) expect(original[2]).toContain(`${name}@`);
    expect(original[1]).toBe(readFileSync(path.join(root, 'src/scripts/setup-runtime-entry.ts'), 'utf8'));
  });

  it.each(ARTIFACTS)('rejects stale %s without repairing it or copying it', name => {
    const root = generatorFixture();
    expect(generate(root, '--write').status).toBe(0);
    const file = path.join(root, 'src/scripts', name);
    writeFileSync(file, 'corrupt bootstrap artifact\n');
    for (const mode of ['--check', '--copy']) {
      const result = generate(root, mode);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Stale setup runtime: ${name}`);
    }
    expect(readFileSync(file, 'utf8')).toBe('corrupt bootstrap artifact\n');
    expect(existsSync(path.join(root, 'build/scripts/setup-runtime.generated.mjs'))).toBe(false);
  });

  it('rejects changed runtime inputs until explicitly regenerated', () => {
    const root = generatorFixture();
    expect(generate(root, '--write').status).toBe(0);
    const file = path.join(root, 'src/platform/commands.ts');
    writeFileSync(file, readFileSync(file, 'utf8') + '\nthrow new Error("stale-input-mutant");\n');
    expect(generate(root, '--check').status).toBe(1);
    expect(generate(root, '--write').status).toBe(0);
    expect(generate(root, '--check').status).toBe(0);
  });

  it('refuses a project module outside the reviewed bootstrap closure', () => {
    const root = generatorFixture();
    const entry = path.join(root, 'src/scripts/setup-runtime-entry.ts');
    writeFileSync(path.join(root, 'src/scripts/unreviewed.ts'), 'console.log("closure-mutant");\n');
    writeFileSync(entry, readFileSync(entry, 'utf8') + "import './unreviewed.js';\n");
    const result = generate(root, '--write');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unreviewed bootstrap source');
    expect(existsSync(path.join(root, 'src/scripts/setup-runtime.generated.mjs'))).toBe(false);
  });

  it.each(['source', 'compiled'])('%s reaches argument validation and visible Preflight with no dependencies', route => {
    const root = coldFixture(route);
    const bad = runRoute(root, route, ['--llm', 'bogus']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--llm must be');
    expect(bad.stdout).not.toContain('[1/8]');
    writeFileSync(path.join(root, '.env'), 'MAI_DB_URL=postgresql://p@127.0.0.1:54333/legacy\n');
    const refused = runRoute(root, route, ['--yes']);
    expect(refused.status).toBe(1);
    expect(refused.stdout.split('\n')[0]).toBe('[1/8] Preflight      Checking Node, checkout and reserved ports…');
    expect(refused.stderr).toContain('Setup failed at [1/8] Preflight');
    expect(refused.stderr).toContain('54333');
    expect(refused.stdout).not.toContain('[2/8]');
    expect(refused.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
  });

  it.each(['source', 'compiled'])('%s refuses a missing bundle before any stage', route => {
    const root = coldFixture(route);
    rmSync(path.join(root, route === 'source' ? 'src' : 'build', 'scripts/setup-runtime.generated.mjs'));
    const result = runRoute(root, route, ['--yes']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stdout).not.toContain('[1/8]');
  });

  it('the real default command adapter preserves argv, stdin and explicit environment', () => {
    const io = defaultSetupIO();
    const args = ['space value', 'a&b', '(x)%value%', 'café'];
    const script = "const fs=require('node:fs'); console.log(JSON.stringify({argv:process.argv.slice(1),stdin:fs.readFileSync(0,'utf8'),keys:Object.keys(process.env).filter(k=>k.startsWith('MAI_')).sort()}));";
    const result = io.runCommand(process.execPath, ['-e', script, ...args], {
      timeoutMs: 5000, stdin: 'stdin payload', env: { MAI_BOOTSTRAP_CANARY: 'present' },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv: args, stdin: 'stdin payload', keys: ['MAI_BOOTSTRAP_CANARY'] });
  });

  it('build checks before compiling, copies before stamping, and never silently regenerates', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toBe('node scripts/setup-runtime.mjs --check && tsc && node scripts/setup-runtime.mjs --copy && node scripts/stamp-build.mjs');
    expect(pkg.scripts['build:setup-runtime']).toBe('node scripts/setup-runtime.mjs --write');
    expect(pkg.scripts['check:setup-runtime']).toBe('node scripts/setup-runtime.mjs --check');
    expect(pkg.scripts.setup).toBe('node src/scripts/setup.ts');
  });
});
