#!/usr/bin/env node
// mai-mcp thin installer (Plan 15 Task 5). Dependency-free by contract: the
// npm package carries ONLY this file plus metadata. It clones the real
// repository into a visible checkout, builds there, and delegates every
// substantive command to that checkout's own bin — with the CALLER's original
// working directory preserved, because repo-scoped commands must target the
// project the user launched from, never the brain checkout and never a cache.
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import os, { homedir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

export const PUBLIC_REPO = 'https://github.com/maikai-group/mai-mcp.git';
export const DEFAULT_HOME = join(homedir(), 'mai-mcp');

export class InstallerError extends Error {}

function windowsExtensions(name, env) {
  const configured = env.PATHEXT ?? env.Pathext ?? env.pathext ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = [];
  const seen = new Set();
  const explicit = path.extname(name);
  for (const extension of [explicit, ...configured.split(';')]) {
    if (!extension) continue;
    const normalized = extension.startsWith('.') ? extension : `.${extension}`;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extensions.push(normalized);
  }
  return extensions;
}

export function executableExtensions(spec) {
  return spec.platform === 'win32' ? windowsExtensions('', spec.env) : [''];
}

function isExecutable(candidate, platform, allowedExtensions) {
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (platform === 'win32') {
    const extension = path.extname(candidate).toLowerCase();
    return allowedExtensions.some((value) => value.toLowerCase() === extension);
  }
  return (stat.mode & 0o111) !== 0;
}

function candidateNames(name, spec) {
  if (spec.platform !== 'win32') return [name];
  const extensions = windowsExtensions(name, spec.env);
  const explicit = path.extname(name);
  if (explicit) return [name];
  return extensions.map((extension) => `${name}${extension}`);
}

export function findExecutable(name, partial = {}) {
  if (!name || name.includes('\0')) return null;
  const spec = {
    platform: partial.platform ?? process.platform,
    env: partial.env ?? process.env,
  };
  const allowedExtensions = spec.platform === 'win32' ? windowsExtensions(name, spec.env) : [''];
  const explicitPath = name.includes('/') || name.includes('\\');
  const absoluteForPlatform = path.isAbsolute(name)
    || (spec.platform === 'win32' && path.win32.isAbsolute(name));
  if (explicitPath && !absoluteForPlatform) return null;
  const roots = explicitPath
    ? ['']
    : (spec.env.PATH ?? spec.env.Path ?? spec.env.path ?? '').split(path.delimiter).filter(Boolean);
  for (const root of roots) {
    for (const candidateName of candidateNames(name, spec)) {
      const candidate = root ? path.join(root, candidateName) : candidateName;
      if (isExecutable(candidate, spec.platform, allowedExtensions)) return path.resolve(candidate);
    }
  }
  return null;
}

function isExistingFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function resolveNpmCli(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const override = env.MAI_NPM_CLI;
  if (override !== undefined) {
    if (!path.isAbsolute(override) || !isExistingFile(override)) {
      throw new InstallerError('MAI_NPM_CLI must be an absolute existing file');
    }
    return path.resolve(override);
  }
  const npmCli = platform === 'win32'
    ? path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!isExistingFile(npmCli)) {
    throw new InstallerError(
      `npm-cli.js not found beside ${execPath}; install Node from nodejs.org or set MAI_NPM_CLI to its path`
    );
  }
  return path.resolve(npmCli);
}

export function validatePromptedInstallPath(value) {
  if (/[\r\n\0]/u.test(value)) {
    throw new InstallerError('install path must not contain a newline or NUL');
  }
  return value;
}

const USAGE = [
  'usage: npx mai-mcp setup [--dir PATH] [--yes] [--update] [-- <setup flags...>]',
  '       npx mai-mcp <verb> [...]      (pass-through to an existing checkout)',
  '       npx mai-mcp --help | --version',
].join('\n');

/** `~` and `~/...` only; `~user` is deliberately unsupported. */
export function expandHomePath(value, home = homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  if (value.startsWith('~')) {
    throw new InstallerError(`'~user' expansion is not supported — use an absolute path or ~/...: ${value}`);
  }
  return value;
}

/** Origin equality ignores a trailing slash/.git and case only. */
export function normalizeOriginUrl(url) {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
}

/**
 * Parse the installer's own surface. Setup-mode flags are validated strictly
 * (an unknown flag fails BEFORE any mutation); pass-through tokens belong to
 * the checkout CLI and travel untouched.
 */
export function parseInstallerArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { mode: 'help' };
  if (argv[0] === '--version') return { mode: 'version' };
  const out = { mode: 'setup', dir: undefined, yes: false, update: false, forwarded: [], passthrough: [] };
  if (argv[0] === 'setup') {
    for (let i = 1; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === '--') {
        out.forwarded = argv.slice(i + 1); // byte-for-byte
        break;
      }
      if (token === '--dir') {
        const value = argv[i + 1];
        if (value === undefined) throw new InstallerError(`--dir requires a value\n${USAGE}`);
        out.dir = value;
        i += 1;
      } else if (token === '--yes') {
        out.yes = true;
      } else if (token === '--update') {
        out.update = true;
      } else {
        throw new InstallerError(`unknown installer flag '${token}'\n${USAGE}`);
      }
    }
    return out;
  }
  // Pass-through mode: an optional leading --dir selects the checkout; every
  // remaining token goes to the checkout CLI unmodified.
  out.mode = 'passthrough';
  let rest = argv;
  if (rest[0] === '--dir') {
    const value = rest[1];
    if (value === undefined) throw new InstallerError(`--dir requires a value\n${USAGE}`);
    out.dir = value;
    rest = rest.slice(2);
  }
  if (rest.length === 0) return { mode: 'help' };
  out.passthrough = rest;
  return out;
}

function nearestExistingAncestor(dir) {
  let current = dir;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function runBounded(command, args, options) {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  return {
    status: typeof res.status === 'number' ? res.status : null,
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

export function runNpm(npmCli, npmArgs, options) {
  return runBounded(process.execPath, [npmCli, ...npmArgs], options);
}

function exitStatusOf(result) {
  if (typeof result.status === 'number') return result.status;
  if (result.signal !== null) {
    const signals = os.constants.signals;
    const num = typeof signals[result.signal] === 'number' ? signals[result.signal] : 0;
    return 128 + num;
  }
  return 1;
}

function requireEnvironment() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) {
    throw new InstallerError(`Node ${process.versions.node} is not supported — install Node 24, then rerun`);
  }
  const git = findExecutable(process.platform === 'win32' ? 'git.exe' : 'git');
  if (git === null) {
    throw new InstallerError('git is required — install git, then rerun');
  }
  const probe = runBounded(git, ['--version'], { timeoutMs: 15_000 });
  if (probe.status !== 0) {
    throw new InstallerError('git is required — install git, then rerun');
  }
  return git;
}

async function resolveTargetDir(parsed) {
  if (parsed.dir !== undefined) return path.resolve(expandHomePath(parsed.dir));
  if (parsed.yes) return path.resolve(DEFAULT_HOME);
  if (process.stdin.isTTY !== true) {
    throw new InstallerError('not a terminal — rerun with --yes (default home) or --dir PATH');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = validatePromptedInstallPath(
      await rl.question(`Install the mai-mcp checkout to [${DEFAULT_HOME}]: `)
    ).trim();
    return path.resolve(answer === '' ? DEFAULT_HOME : expandHomePath(answer));
  } finally {
    rl.close();
  }
}

function verifyExistingCheckout(target, git) {
  if (!existsSync(join(target, '.git'))) {
    throw new InstallerError(`${target} exists but is not a git checkout — choose another --dir or remove it yourself`);
  }
  const origin = runBounded(git, ['-C', target, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 });
  if (origin.status !== 0 || normalizeOriginUrl(origin.stdout) !== normalizeOriginUrl(PUBLIC_REPO)) {
    throw new InstallerError(
      `${target} is a different repository (origin ${origin.stdout.trim() || 'unknown'}) — the installer only manages clones of ${PUBLIC_REPO}`
    );
  }
}

function delegate(target, argv, consumerCwd) {
  const entry = join(target, 'build', 'entry.js');
  const res = spawnSync(process.execPath, [entry, ...argv], {
    cwd: consumerCwd, // the caller's project, never the brain checkout
    stdio: 'inherit',
    shell: false,
  });
  return exitStatusOf({ status: typeof res.status === 'number' ? res.status : null, signal: res.signal ?? null });
}

async function runSetupMode(parsed) {
  const consumerCwd = process.cwd(); // captured BEFORE any resolution
  const git = requireEnvironment();
  const target = await resolveTargetDir(parsed);
  try {
    accessSync(nearestExistingAncestor(target), fsConstants.W_OK);
  } catch {
    throw new InstallerError(`no writable ancestor for ${target} — choose another --dir`);
  }

  let createdByThisInvocation = false;
  if (existsSync(target)) {
    verifyExistingCheckout(target, git);
    if (parsed.update) {
      const pull = runBounded(git, ['-C', target, 'pull', '--ff-only'], { timeoutMs: 600_000 });
      if (pull.status !== 0) {
        throw new InstallerError(`git pull --ff-only failed:\n${pull.stderr.trim()}`);
      }
    }
  } else {
    createdByThisInvocation = true;
    const clone = runBounded(git, ['clone', '--depth', '1', PUBLIC_REPO, target], {
      cwd: nearestExistingAncestor(path.dirname(target)),
      timeoutMs: 600_000,
    });
    if (clone.status !== 0) {
      // Remove ONLY a partial target this invocation created.
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      throw new InstallerError(`git clone failed:\n${clone.stderr.trim()}`);
    }
  }

  const needBuild = createdByThisInvocation || parsed.update || !existsSync(join(target, 'build', 'entry.js'));
  if (needBuild) {
    const npmCli = resolveNpmCli();
    const install = runNpm(npmCli, ['install'], {
      cwd: target,
      timeoutMs: 900_000,
      stdio: 'inherit',
    });
    if (install.status !== 0) {
      throw new InstallerError('npm install failed in the checkout — fix the error above, then rerun');
    }
    const build = runNpm(npmCli, ['run', 'build'], {
      cwd: target,
      timeoutMs: 900_000,
      stdio: 'inherit',
    });
    if (build.status !== 0) {
      throw new InstallerError('npm run build failed in the checkout — fix the error above, then rerun');
    }
  }

  const setupArgv = ['setup', ...(parsed.yes ? ['--yes'] : []), ...parsed.forwarded];
  const code = delegate(target, setupArgv, consumerCwd);
  if (code === 0) {
    console.log(`mai-mcp home: ${target}`);
  }
  process.exitCode = code;
}

function runPassthroughMode(parsed) {
  const consumerCwd = process.cwd();
  const git = requireEnvironment();
  const target = parsed.dir !== undefined ? path.resolve(expandHomePath(parsed.dir)) : DEFAULT_HOME;
  if (!existsSync(target) || !existsSync(join(target, '.git')) || !existsSync(join(target, 'build', 'entry.js'))) {
    throw new InstallerError(`no installed checkout at ${target} — run \`npx mai-mcp setup\` first`);
  }
  verifyExistingCheckout(target, git);
  process.exitCode = delegate(target, parsed.passthrough, consumerCwd);
}

export async function runInstaller(argv = process.argv.slice(2)) {
  const parsed = parseInstallerArgs(argv);
  if (parsed.mode === 'help') {
    console.log(USAGE);
    return;
  }
  if (parsed.mode === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(String(pkg.version));
    return;
  }
  if (parsed.mode === 'setup') {
    await runSetupMode(parsed);
    return;
  }
  runPassthroughMode(parsed);
}

const invoked = process.argv[1];
let isDirectEntry = false;
if (invoked !== undefined && invoked !== '') {
  isDirectEntry = import.meta.url === pathToFileURL(invoked).href;
  if (!isDirectEntry) {
    try {
      const { realpathSync } = await import('node:fs');
      isDirectEntry = import.meta.url === pathToFileURL(realpathSync(invoked)).href;
    } catch {
      isDirectEntry = false;
    }
  }
}
if (isDirectEntry) {
  try {
    await runInstaller();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`mai-mcp installer: ${message}`);
    process.exitCode = 1;
  }
}
