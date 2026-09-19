// mai setup — the eight-stage guided install (Plan 15 Task 4, spec §3.3).
//
// Node 24 source bootstrap: Node builtins plus the committed generated runtime.
// Other project runtime modules load dynamically only after Build.
// Shared TypeScript remains authoritative; regenerate the runtime explicitly.
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DatabaseSetupError, parseDatabaseUrl, ensureDatabase,
  findExecutable, spawnArgvSync, defaultProcessOps,
} from './setup-runtime.generated.mjs';
import type {
  DatabaseSetupIO, SetupCommandResult, ParsedDatabaseUrl, DbInitResult,
} from './database-setup.js';
export type { SetupCommandResult } from './database-setup.js';
import type { InitArgs, InitResult, PreFileLlmAuthority } from './init.js';
import type { ProjectVerification } from './verify.js';
import type { SkillRequest, SkillRunResult } from './skills.js';

/** The checkout this setup belongs to — src/scripts/ and build/scripts/ both
 * sit exactly two levels below the root. Never taken from env or cwd. */
const SETUP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type SetupStage =
  | 'Preflight' | 'Database' | 'Schema' | 'Build'
  | 'Project' | 'Harnesses' | 'Skills' | 'Verify';
export type OutcomeKind = 'applied' | 'current' | 'warning';
export interface SetupArgs {
  slug?: string;
  root?: string;
  harness?: 'claude-code' | 'codex' | 'all';
  llm?: 'claude-code' | 'codex-cli' | 'none';
  embeddings?: 'local' | 'none';
  yes?: boolean;
  noSkills?: boolean;
  cwd?: string;
}
export interface SetupResult {
  slug: string;
  root: string;
  harnesses: string[];
  databaseReady: true;
  skills: SkillRunResult | null;
  verification: ProjectVerification;
}
export interface SetupEnvironment {
  values: Readonly<Record<string, string | undefined>>;
  preFileAuthority: Readonly<PreFileLlmAuthority>;
}
export interface SetupIO extends DatabaseSetupIO {
  /** FIRST Preflight operation: capture pre-file LLM authority, then load the
   * checkout .env with the native loader (existing process vars win). */
  loadEnvironment(root: string): SetupEnvironment;
  runInit(args: InitArgs): Promise<InitResult>;
  runSkills(request: SkillRequest): Promise<SkillRunResult>;
  verifyProject(
    slug: string,
    opts: { smoke?: boolean; sharedSkills?: 'required' | 'deferred' }
  ): Promise<ProjectVerification>;
  cwd(): string;
  isTTY: boolean;
  print(line: string): void;
  ask(question: string): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  describeTcpListener(port: number): Promise<string | null>;
  probeTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean>;
  fileExists(p: string): boolean;
  isDirectory(p: string): boolean;
  writeFile(p: string, content: string): void;
  mkdir(p: string): void;
}

export const STAGES: ReadonlyArray<{ label: SetupStage; message: string }> = [
  { label: 'Preflight', message: 'Checking Node, checkout and reserved ports…' },
  { label: 'Database', message: 'Starting or reusing mai-brain-pg…' },
  { label: 'Schema', message: 'Applying the current schema and migrations…' },
  { label: 'Build', message: 'Installing dependencies and building mai-mcp…' },
  { label: 'Project', message: 'Resolving the project slug and root…' },
  { label: 'Harnesses', message: 'Wiring every selected/detected harness…' },
  { label: 'Skills', message: 'Installing skills and reviewer agents…' },
  { label: 'Verify', message: 'Proving the completed installation…' },
];

export class SetupError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoWithCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}

function stageIndex(stage: SetupStage): number {
  return STAGES.findIndex((s) => s.label === stage) + 1;
}

function stageFail(stage: SetupStage, cause: string, recovery: string): never {
  throw new SetupError(`Setup failed at [${stageIndex(stage)}/8] ${stage}: ${cause}. ${recovery}`);
}

// ------------------------------------------------------------- pure helpers

function quoteForOperatorShell(value: string, platform: NodeJS.Platform): string {
  const escaped = platform === 'win32'
    ? value.replaceAll("'", "''")
    : value.replaceAll("'", "'\"'\"'");
  return `'${escaped}'`;
}

export function dashboardPersistenceSetupCommand(
  checkoutRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === 'darwin') {
    const launcher = path.posix.join(checkoutRoot, 'scripts', 'mai-brain-web-launchd.sh');
    return `/bin/bash ${quoteForOperatorShell(launcher, platform)} install`;
  }
  if (platform === 'win32') {
    const launcher = path.win32.join(checkoutRoot, 'scripts', 'windows', 'install-dashboard.ps1');
    return `& ${quoteForOperatorShell(launcher, platform)} -Action Install -CheckoutRoot ${quoteForOperatorShell(checkoutRoot, platform)}`;
  }
  return null;
}

export function assertNode24(nodeVersion: string): void {
  const major = Number(nodeVersion.split('.')[0]);
  if (major !== 24) {
    stageFail(
      'Preflight',
      `Node ${nodeVersion} is not supported`,
      'Install Node 24 (see .nvmrc), activate it, then rerun'
    );
  }
}

export function assertSafeBrainRoot(root: string, hasGitDir: boolean): void {
  const segments = root.split(path.sep);
  if (segments.some((s) => s === '_npx' || s === 'node_modules')) {
    stageFail(
      'Preflight',
      `checkout root sits in a package cache: ${root}`,
      'Run `npx mai-mcp setup` so a real clone becomes the brain root — a cache directory must never hold brain state'
    );
  }
  if (!hasGitDir) {
    stageFail(
      'Preflight',
      `no .git directory at ${root}`,
      'Setup requires a real mai-mcp checkout — clone it (or run npx mai-mcp setup), then rerun from that clone'
    );
  }
}

export function resolveSetupRoot(value: string, cwd: string): string {
  let expanded = value;
  if (value === '~') expanded = process.env.HOME ?? homedir();
  else if (value.startsWith('~/')) expanded = path.join(process.env.HOME ?? homedir(), value.slice(2));
  else if (value.startsWith('~')) {
    stageFail('Project', `'~user' expansion is not supported: ${value}`, 'Use an absolute path or ~/..., then rerun');
  }
  return path.resolve(cwd, expanded);
}

export function deriveProjectIdentity(basename: string): string {
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface StampShape {
  version: string;
  sha: string;
  dirty: boolean;
  builtAt: string;
}
function parseStamp(text: string | null): StampShape | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (Object.keys(parsed).sort().join(',') !== 'builtAt,dirty,sha,version') return null;
  const { version, sha, dirty, builtAt } = parsed;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof sha !== 'string' || sha.length === 0) return null;
  if (typeof dirty !== 'boolean') return null;
  if (typeof builtAt !== 'string' || !Number.isFinite(Date.parse(builtAt))) return null;
  return { version, sha, dirty, builtAt };
}

/** The exact dirty-input path set that can change compiled output. */
export const BUILD_INPUT_PATHS = [
  'src',
  'scripts/stamp-build.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
] as const;

/** Pure build-freshness predicate (spec §3.2 step 4 as amended by decisions
 * 1696e956/624744c1): stamp SHA vs HEAD plus tracked+untracked dirty inputs —
 * never mtimes. The HEAD comparison is deliberately broader than the input
 * set: any commit advances the stamp's checkout identity. */
export function buildNeeded(probe: {
  buildEntryExists: boolean;
  stampText: string | null;
  headShort: string | null;
  dirtyInputStatus: string;
}): { needed: boolean; reason: string } {
  if (!probe.buildEntryExists) return { needed: true, reason: 'build/index.js is missing' };
  const stamp = parseStamp(probe.stampText);
  if (stamp === null) return { needed: true, reason: 'build stamp is missing or malformed' };
  if (stamp.sha === 'unknown') return { needed: true, reason: 'build stamp has no git identity' };
  if (probe.headShort !== null && stamp.sha !== probe.headShort) {
    return { needed: true, reason: `build stamp ${stamp.sha} is behind HEAD ${probe.headShort}` };
  }
  if (probe.dirtyInputStatus.trim().length > 0) {
    return { needed: true, reason: 'build inputs have uncommitted changes' };
  }
  return { needed: false, reason: `build is current (${stamp.sha}@${stamp.builtAt})` };
}

// ------------------------------------------------------------ default SetupIO

interface BuiltInitModule {
  runInit(args: InitArgs): Promise<InitResult>;
}
interface BuiltVerifyModule {
  verifyProject(
    slug: string,
    opts: { smoke?: boolean; sharedSkills?: 'required' | 'deferred' }
  ): Promise<ProjectVerification>;
}
interface BuiltSkillsModule {
  runSkills(request: SkillRequest): SkillRunResult;
}
interface BuiltExitModule {
  finishAndExit(code: number): Promise<void>;
}
function isBuiltInitModule(m: unknown): m is BuiltInitModule {
  return isRecord(m) && typeof m.runInit === 'function';
}
function isBuiltVerifyModule(m: unknown): m is BuiltVerifyModule {
  return isRecord(m) && typeof m.verifyProject === 'function';
}
function isBuiltSkillsModule(m: unknown): m is BuiltSkillsModule {
  return isRecord(m) && typeof m.runSkills === 'function';
}
function isBuiltExitModule(m: unknown): m is BuiltExitModule {
  return isRecord(m) && typeof m.finishAndExit === 'function';
}
function missingBuilt(name: string): never {
  throw new SetupError(`compiled module is missing ${name} — run npm run build and retry`);
}

async function importBuilt(root: string, relative: string): Promise<unknown> {
  const file = path.join(root, 'build', relative);
  const specifier = pathToFileURL(file).href;
  const loaded: unknown = await import(specifier);
  return loaded;
}

export function defaultSetupIO(): SetupIO {
  return {
    loadEnvironment: (root: string): SetupEnvironment => {
      const preFileAuthority: PreFileLlmAuthority = {
        provider: process.env.MAI_LLM_PROVIDER,
        summary: process.env.MAI_LLM_SUMMARY,
      };
      const envFile = path.join(root, '.env');
      // Classify missing vs unreadable BEFORE the native loader: Node's
      // process.loadEnvFile reports permission failures as ENOENT, which
      // would silently skip a real file the operator cannot read.
      let present = true;
      try {
        statSync(envFile);
      } catch (err) {
        if (isErrnoWithCode(err, 'ENOENT')) present = false;
        else {
          const message = err instanceof Error ? err.message : String(err);
          stageFail('Preflight', `cannot read ${envFile} (${message})`, 'Fix the file permissions or contents, then rerun');
        }
      }
      if (present) {
        try {
          accessSync(envFile, fsConstants.R_OK);
          process.loadEnvFile(envFile);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          stageFail('Preflight', `cannot read ${envFile} (${message})`, 'Fix the file permissions or contents, then rerun');
        }
      }
      // A missing checkout .env is current/no-op.
      return { values: { ...process.env }, preFileAuthority: Object.freeze(preFileAuthority) };
    },
    runInit: async (args: InitArgs): Promise<InitResult> => {
      const mod = await importBuilt(SETUP_ROOT, path.join('scripts', 'init.js'));
      if (!isBuiltInitModule(mod)) missingBuilt('runInit');
      return mod.runInit(args);
    },
    runSkills: async (request: SkillRequest): Promise<SkillRunResult> => {
      const mod = await importBuilt(SETUP_ROOT, path.join('scripts', 'skills.js'));
      if (!isBuiltSkillsModule(mod)) missingBuilt('runSkills');
      return mod.runSkills(request);
    },
    verifyProject: async (slug, opts): Promise<ProjectVerification> => {
      const mod = await importBuilt(SETUP_ROOT, path.join('scripts', 'verify.js'));
      if (!isBuiltVerifyModule(mod)) missingBuilt('verifyProject');
      return mod.verifyProject(slug, opts);
    },
    cwd: () => process.cwd(),
    isTTY: process.stdin.isTTY === true,
    print: (line: string) => {
      console.log(line);
    },
    ask: async (question: string): Promise<string> => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    whichCommand: name => findExecutable(name),
    describeTcpListener: port => defaultProcessOps().describeTcpListener(port),
    runCommand: (command, args, options): SetupCommandResult => {
      const res = spawnArgvSync(command, [...args], {
        cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024,
        env: options.env === undefined ? process.env : { ...options.env },
        input: options.stdin, shell: false,
      });
      return {
        status: typeof res.status === 'number' ? res.status : 1,
        stdout: res.stdout?.toString() ?? '', stderr: res.stderr?.toString() ?? '',
      };
    },
    probeTcpPort: (host, port, timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const socket = net.connect({ host, port });
        const done = (result: boolean): void => {
          socket.destroy();
          resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
      }),
    fileExists: (p) => existsSync(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (p, content) => {
      writeFileSync(p, content);
    },
    mkdir: (p) => {
      mkdirSync(p, { recursive: true });
    },
    readdir: (p) => readdirSync(p),
  };
}

// ------------------------------------------------------------- orchestrator

const CHILD_TIMEOUT = 120_000;
const READINESS_BUDGET_MS = 60_000;

function rethrowSetupDatabaseError(error: unknown): never {
  if (error instanceof DatabaseSetupError) {
    stageFail(error.stage, error.causeText, error.recovery);
  }
  throw error;
}

export async function runSetup(args: SetupArgs, io: SetupIO = defaultSetupIO()): Promise<SetupResult> {
  const printStage = (stage: SetupStage): void => {
    const n = stageIndex(stage);
    const entry = STAGES[n - 1];
    io.print(`[${n}/8] ${entry.label.padEnd(15)}${entry.message}`);
  };
  const outcome = (kind: OutcomeKind, text: string): void => {
    const symbol = kind === 'applied' ? '✓' : kind === 'current' ? '↷' : '!';
    io.print(`  ${symbol} ${text}`);
  };

  // ---- [1/8] Preflight ----
  printStage('Preflight');
  const environment = io.loadEnvironment(SETUP_ROOT); // FIRST Preflight operation
  assertNode24(process.versions.node);
  assertSafeBrainRoot(SETUP_ROOT, io.isDirectory(path.join(SETUP_ROOT, '.git')));
  let db: ParsedDatabaseUrl;
  try {
    db = parseDatabaseUrl(
      environment.values.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain'
    );
  } catch (error) {
    rethrowSetupDatabaseError(error);
  }
  outcome('applied', `Node ${process.versions.node}, checkout ${SETUP_ROOT}, database ${db.host}:${db.port}/${db.database}`);

  // ---- [2/8] Database ----
  printStage('Database');
  if (io.whichCommand('docker') === null) {
    stageFail('Database', 'Docker is not installed', 'Install Docker Desktop (or the docker CLI), then rerun');
  }
  const version = io.runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: CHILD_TIMEOUT,
    env: { PATH: process.env.PATH },
  });
  if (version.status !== 0) {
    stageFail('Database', 'the Docker daemon is not running', 'Start Docker Desktop, then rerun');
  }
  const running = io.runCommand('docker', ['ps', '--filter', 'name=mai-brain-pg', '--format', '{{.Names}}'], {
    timeoutMs: CHILD_TIMEOUT,
    env: { PATH: process.env.PATH },
  });
  const containerRunning = running.status === 0 && running.stdout.split('\n').some((l) => l.trim() === 'mai-brain-pg');
  if (containerRunning) {
    outcome('current', 'reusing the running mai-brain-pg container');
  } else {
    const portBusy = await io.probeTcpPort('127.0.0.1', 54334, 2_000);
    if (portBusy) {
      const holder = await io.describeTcpListener(54334);
      stageFail(
        'Database',
        holder ? `port 54334 is held by a foreign process:\n${holder}` : 'port 54334 is busy; stop its listener, then rerun',
        'No Docker change was made'
      );
    }
    const compose = io.runCommand('docker', ['compose', 'up', '-d'], {
      cwd: SETUP_ROOT,
      timeoutMs: CHILD_TIMEOUT,
      env: { PATH: process.env.PATH },
    });
    if (compose.status !== 0) {
      stageFail('Database', `docker compose up -d failed:\n${compose.stderr.trim()}`, 'Fix the compose error, then rerun');
    }
    outcome('applied', 'started mai-brain-pg via docker compose');
  }
  // Readiness: one 60,000ms budget from the FIRST attempt; command runtime
  // and sleeps consume the same budget, and every child timeout is exactly
  // the remaining budget — attempt count is deliberately not the authority.
  {
    const deadline = io.now() + READINESS_BUDGET_MS;
    let ready = false;
    for (;;) {
      const remaining = deadline - io.now();
      if (remaining <= 0) break;
      const probe = io.runCommand('docker', ['exec', 'mai-brain-pg', 'pg_isready'], {
        timeoutMs: remaining,
        env: { PATH: process.env.PATH },
      });
      if (probe.status === 0) {
        ready = true;
        break;
      }
      const afterAttempt = deadline - io.now();
      if (afterAttempt <= 0) break;
      await io.sleep(Math.min(1_000, afterAttempt));
    }
    if (!ready) {
      stageFail(
        'Database',
        'Postgres did not become ready within 60 seconds',
        'Check `docker logs mai-brain-pg`, then rerun'
      );
    }
    outcome('applied', 'Postgres is accepting connections');
  }

  // ---- [3/8] Schema ----
  printStage('Schema');
  let databaseResult: DbInitResult;
  try {
    databaseResult = await ensureDatabase({ checkoutRoot: SETUP_ROOT, dbUrl: db.raw }, io);
  } catch (error) {
    rethrowSetupDatabaseError(error);
  }
  const schemaApplied = databaseResult.databaseCreated || databaseResult.schemaApplied;
  outcome(
    schemaApplied ? 'applied' : 'current',
    `${schemaApplied ? 'applied schema and' : 'schema present;'} ${databaseResult.migrationsApplied} forward migration(s) via ${databaseResult.mode === 'docker' ? 'container' : 'host'} psql`
  );

  // ---- [4/8] Build ----
  printStage('Build');
  if (!io.isDirectory(path.join(SETUP_ROOT, 'node_modules'))) {
    const install = io.runCommand('npm', ['install'], {
      cwd: SETUP_ROOT,
      timeoutMs: 600_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    if (install.status !== 0) {
      stageFail('Build', `npm install failed:\n${install.stderr.slice(-2_000)}`, 'Fix the install error, then rerun');
    }
    outcome('applied', 'installed dependencies');
  }
  const head = io.runCommand('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: SETUP_ROOT,
    timeoutMs: CHILD_TIMEOUT,
    env: { PATH: process.env.PATH },
  });
  const dirty = io.runCommand(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', ...BUILD_INPUT_PATHS],
    { cwd: SETUP_ROOT, timeoutMs: CHILD_TIMEOUT, env: { PATH: process.env.PATH } }
  );
  const need = buildNeeded({
    buildEntryExists: io.fileExists(path.join(SETUP_ROOT, 'build', 'index.js')),
    stampText: io.readFile(path.join(SETUP_ROOT, 'build', 'build-info.json')),
    headShort: head.status === 0 ? head.stdout.trim() : null,
    dirtyInputStatus: dirty.status === 0 ? dirty.stdout : '',
  });
  if (need.needed) {
    const build = io.runCommand('npm', ['run', 'build'], {
      cwd: SETUP_ROOT,
      timeoutMs: 600_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    if (build.status !== 0) {
      stageFail('Build', `npm run build failed (${need.reason}):\n${build.stderr.slice(-2_000)}`, 'Fix the build error, then rerun');
    }
    outcome('applied', `rebuilt (${need.reason})`);
  } else {
    outcome('current', need.reason);
  }
  let dashboardBuilt = false;
  if (!io.fileExists(path.join(SETUP_ROOT, 'frontend', 'dist', 'index.html'))) {
    const installFrontend = io.runCommand('npm', ['--prefix', 'frontend', 'ci'], {
      cwd: SETUP_ROOT, timeoutMs: 600_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const buildFrontend = installFrontend.status === 0
      ? io.runCommand('npm', ['--prefix', 'frontend', 'run', 'build'], {
          cwd: SETUP_ROOT, timeoutMs: 600_000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        })
      : installFrontend;
    if (installFrontend.status === 0 && buildFrontend.status === 0) {
      dashboardBuilt = true;
      outcome('applied', 'built dashboard assets');
    } else {
      outcome('warning', 'dashboard assets were not built; setup will continue');
    }
  } else {
    outcome('current', 'dashboard assets already present');
  }

  // ---- [5/8] Project ----
  printStage('Project');
  const cwd = args.cwd ?? io.cwd();
  const toplevel = io.runCommand('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeoutMs: CHILD_TIMEOUT,
    env: { PATH: process.env.PATH },
  });
  let root = resolveSetupRoot(
    args.root ?? (toplevel.status === 0 ? toplevel.stdout.trim() : cwd),
    cwd
  );
  if (args.root === undefined && toplevel.status !== 0) {
    outcome('warning', `${cwd} is not a git repository — using the directory itself as the project root`);
  }
  let slug = args.slug ?? deriveProjectIdentity(path.basename(root));
  if (io.isTTY && args.yes !== true) {
    const editedSlug = (await io.ask(`Project slug [${slug}]: `)).trim();
    if (editedSlug !== '') slug = editedSlug;
    const editedRoot = (await io.ask(`Project root [${root}]: `)).trim();
    if (editedRoot !== '') root = resolveSetupRoot(editedRoot, cwd);
  } else if (!io.isTTY && args.yes !== true) {
    stageFail(
      'Project',
      'not a terminal and --yes was not given',
      'Rerun interactively, or pass --yes (optionally with --slug/--root)'
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    stageFail('Project', `derived slug '${slug}' is not lowercase kebab-case`, 'Rerun with an explicit --slug');
  }
  if (!io.isDirectory(root)) {
    stageFail('Project', `project root is not an existing directory: ${root}`, 'Fix --root or choose an existing directory, then rerun');
  }
  outcome('applied', `project '${slug}' at ${root}`);

  // ---- [6/8] Harnesses ----
  printStage('Harnesses');
  let harnesses: string[];
  if (args.harness === 'claude-code') harnesses = ['claude-code'];
  else if (args.harness === 'codex') harnesses = ['codex'];
  else if (args.harness === 'all') harnesses = ['claude-code', 'codex'];
  else {
    const claude = io.whichCommand('claude') !== null || io.isDirectory(path.join(root, '.claude'));
    const codex = io.whichCommand('codex') !== null || io.isDirectory(path.join(root, '.codex'));
    harnesses = [...(claude ? ['claude-code'] : []), ...(codex ? ['codex'] : [])];
    if (harnesses.length === 0) {
      stageFail(
        'Harnesses',
        'no harness detected (no claude/codex binary and no .claude/.codex directory)',
        'Rerun with an explicit --harness claude-code|codex|all'
      );
    }
  }
  let initResult: InitResult;
  try {
    initResult = await io.runInit({
      slug,
      root,
      repos: [root],
      draftTopics: false,
      harnesses,
      llm: args.llm,
      embeddings: args.embeddings,
      yes: args.yes,
      printSummary: false,
      sharedSkillsVerification: 'deferred',
      preFileLlmAuthority: environment.preFileAuthority,
    });
  } catch (err) {
    if (err instanceof SetupError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    stageFail('Harnesses', message, 'Resolve the reported init failure, then rerun');
  }
  outcome('applied', `wired ${initResult.harnesses.join(' + ')} across ${initResult.repos.length} repo(s)`);

  // ---- [7/8] Skills ----
  printStage('Skills');
  let skills: SkillRunResult | null = null;
  if (args.noSkills === true) {
    outcome('current', 'skipped (--no-skills)');
  } else {
    const wantsClaude = harnesses.includes('claude-code');
    const wantsCodex = harnesses.includes('codex');
    const target: 'claude' | 'codex' | 'all' = wantsClaude && wantsCodex ? 'all' : wantsClaude ? 'claude' : 'codex';
    skills = await io.runSkills({ action: 'install', target, codexScope: wantsCodex ? 'user' : undefined });
    if (!skills.ok) {
      stageFail(
        'Skills',
        `skill installation refused:\n${skills.notes.join('\n')}`,
        'Resolve the listed conflicts (mai skills install --force after review), then rerun'
      );
    }
    outcome('applied', `installed the complete suite for target '${target}'`);
  }

  // ---- [8/8] Verify ----
  printStage('Verify');
  const verification = await io.verifyProject(slug, { sharedSkills: 'required' });
  if (!verification.ok) {
    const failed = [
      ...verification.shared.filter((c) => !c.ok),
      ...verification.repos.flatMap((r) => r.checks.filter((c) => !c.ok)),
    ]
      .map((c) => `${c.name}: ${c.detail ?? 'failed'}`)
      .join('; ');
    stageFail('Verify', `verification failed (${failed})`, `Fix the listed checks, then rerun mai setup or mai verify ${slug}`);
  }
  outcome('applied', 'verification passed from a fresh metadata read');

  // Success summary — printed only after the undeferred verify passed.
  const stamp = parseStamp(io.readFile(path.join(SETUP_ROOT, 'build', 'build-info.json')));
  const fingerprint = stamp === null ? 'unknown' : `${stamp.version} ${stamp.sha}${stamp.dirty ? '+dirty' : ''} @ ${stamp.builtAt}`;
  io.print('');
  io.print(`mai-mcp setup complete — build ${fingerprint}`);
  io.print(`  project:   '${slug}' at ${root}`);
  io.print(`  database:  ready on ${db.host}:${db.port}/${db.database}`);
  io.print(`  harnesses: ${harnesses.join(', ')}`);
  io.print(`  skills:    ${skills === null ? 'skipped (--no-skills)' : 'complete suite installed'}`);
  io.print(`  agents:    ${skills === null ? 'skipped (--no-skills)' : 'four plan-reviewer definitions installed'}`);
  io.print('Next:');
  io.print('  1. restart Claude Code/Codex so the new .mcp.json and hooks load');
  if (!dashboardBuilt) io.print('  dashboard build: npm run build:web');
  io.print(`  2. run: mai verify ${slug} --smoke`);
  io.print('  3. start dashboard: mai dashboard start');
  const persistenceCommand = dashboardPersistenceSetupCommand(SETUP_ROOT);
  if (persistenceCommand !== null) {
    io.print(`     or enable login persistence (opt-in): ${persistenceCommand}`);
  }

  return { slug, root, harnesses, databaseReady: true, skills, verification };
}

// ---------------------------------------------------------------- source CLI

export const SETUP_USAGE = [
  'usage: mai setup [--slug S] [--root PATH] [--harness claude-code|codex|all]',
  '                 [--llm claude-code|codex-cli|none] [--embeddings local|none]',
  '                 [--yes] [--no-skills]',
].join('\n');

export function parseSetupArgs(argv: readonly string[]): SetupArgs {
  const out: SetupArgs = {};
  const bad = (why: string): never => {
    throw new SetupError(`${why}\n${SETUP_USAGE}`);
  };
  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) bad(`${flag} requires a value`);
    return value;
  };
  const once = new Set<string>();
  const requireOnce = (flag: string): void => {
    if (once.has(flag)) bad(`${flag} may only be given once`);
    once.add(flag);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--slug':
        requireOnce(token);
        out.slug = takeValue(token, i);
        i += 1;
        break;
      case '--root':
        requireOnce(token);
        out.root = takeValue(token, i);
        i += 1;
        break;
      case '--harness': {
        requireOnce(token);
        const value = takeValue(token, i);
        if (value !== 'claude-code' && value !== 'codex' && value !== 'all') {
          bad(`--harness must be claude-code|codex|all, got '${value}'`);
        } else {
          out.harness = value;
        }
        i += 1;
        break;
      }
      case '--llm': {
        requireOnce(token);
        const value = takeValue(token, i);
        if (value !== 'claude-code' && value !== 'codex-cli' && value !== 'none') {
          bad(`--llm must be claude-code|codex-cli|none, got '${value}'`);
        } else {
          out.llm = value;
        }
        i += 1;
        break;
      }
      case '--embeddings': {
        requireOnce(token);
        const value = takeValue(token, i);
        if (value !== 'local' && value !== 'none') {
          bad(`--embeddings must be local|none, got '${value}'`);
        } else {
          out.embeddings = value;
        }
        i += 1;
        break;
      }
      case '--yes':
        requireOnce(token);
        out.yes = true;
        break;
      case '--no-skills':
        requireOnce(token);
        out.noSkills = true;
        break;
      default:
        bad(`unknown setup flag '${token}'`);
    }
  }
  return out;
}

/** Guarded source runner — the ONE termination boundary for every setup
 * route. Post-Build, build/exit.js's finishAndExit drains both success and
 * failure; pre-Build (the only supported no-exit.js case) nothing DB/ONNX has
 * loaded, so process.exitCode + natural drain is correct and process.exit is
 * never called. */
export async function runSetupSource(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let code = 0;
  try {
    const args = parseSetupArgs(argv);
    await runSetup(args);
    code = typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message.startsWith('Setup failed') ? message : `Setup failed: ${message}`);
    code = 1;
  }
  const exitModule = path.join(SETUP_ROOT, 'build', 'exit.js');
  if (existsSync(exitModule)) {
    const loaded: unknown = await import(pathToFileURL(exitModule).href);
    if (!isBuiltExitModule(loaded)) missingBuilt('finishAndExit');
    await loaded.finishAndExit(code); // do NOT catch a drain failure
    return;
  }
  process.exitCode = code;
}

// Direct-entry guard. The realpath fallback matters: argv[1] may reach us
// through a symlinked parent (macOS /tmp, npm bin shims) while import.meta.url
// is always fully resolved.
const invokedEntry = process.argv[1];
if (invokedEntry !== undefined && invokedEntry !== '') {
  let isDirectEntry = import.meta.url === pathToFileURL(invokedEntry).href;
  if (!isDirectEntry) {
    try {
      isDirectEntry = import.meta.url === pathToFileURL(realpathSync(invokedEntry)).href;
    } catch {
      // unresolvable argv[1] — not us
    }
  }
  if (isDirectEntry) void runSetupSource();
}
