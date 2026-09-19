/** Plan 15 Task 4: the eight-stage setup orchestrator. Every case runs
 * against a COMPLETE fake SetupIO — no real Docker, database, home, network,
 * or consent prompt — plus spawn-based route-parity fixtures that copy the
 * setup module plus its committed dependency-free runtime into scratch checkout skeletons and prove the
 * Preflight contract on the real source and compiled entry routes (each rigged
 * to fail during Preflight, so no real mutation can follow). */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  runSetup,
  parseSetupArgs,
  assertNode24,
  assertSafeBrainRoot,
  resolveSetupRoot,
  deriveProjectIdentity,
  buildNeeded,
  dashboardPersistenceSetupCommand,
  STAGES,
  SetupError,
  SETUP_USAGE,
} from '../scripts/setup.js';
import type { SetupIO, SetupCommandResult, SetupEnvironment } from '../scripts/setup.js';
import { parseDatabaseUrl, forwardMigrations } from '../scripts/database-setup.js';
import { ensureDatabase } from '../scripts/database-setup.js';
import type { InitArgs, InitResult } from '../scripts/init.js';
import type { ProjectVerification } from '../scripts/verify.js';
import type { SkillRequest, SkillRunResult } from '../scripts/skills.js';

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SAFE_DB = 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
const VALID_STAMP = JSON.stringify({ version: '0.9.0', sha: 'abc1234', dirty: false, builtAt: '2026-08-17T00:00:00.000Z' });

interface RecordedCommand {
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  stdin?: string;
  at: number;
}

interface FakeConfig {
  env?: Record<string, string | undefined>;
  preFileAuthority?: { provider?: string; summary?: string };
  envError?: string;
  isTTY?: boolean;
  answers?: string[];
  which?: Record<string, string | null>;
  containerRunning?: boolean;
  portBusy?: boolean;
  daemonDown?: boolean;
  composeFails?: boolean;
  readyAfterAttempts?: number;
  commandDurations?: Record<string, number>;
  migrationEntries?: string[];
  failMigration?: string;
  buildEntryExists?: boolean;
  stampText?: string | null;
  headShort?: string;
  dirtyInputs?: string;
  buildFails?: boolean;
  nodeModulesPresent?: boolean;
  consumerRoot?: string;
  consumerIsGit?: boolean;
  claudeDirInRoot?: boolean;
  codexDirInRoot?: boolean;
  runInitError?: Error;
  skillsOk?: boolean;
  verifyOk?: boolean;
  dbMissing?: boolean;
  schemaMissing?: boolean;
  schemaFileMissing?: boolean;
  missingMigration?: string;
  listenerDescription?: string | null;
  frontendDistPresent?: boolean;
  frontendInstallFails?: boolean;
  frontendBuildFails?: boolean;
}

interface FakeWorld {
  io: SetupIO;
  /** The fake consumer checkout, resolved for the host platform (see makeFake). */
  consumerRoot: string;
  printed: string[];
  asked: string[];
  commands: RecordedCommand[];
  fileReads: string[];
  callOrder: string[];
  initCalls: InitArgs[];
  skillCalls: SkillRequest[];
  verifyCalls: Array<{ slug: string; opts: { smoke?: boolean; sharedSkills?: 'required' | 'deferred' } }>;
  clock: { t: number };
}

function makeFake(config: FakeConfig = {}): FakeWorld {
  // runSetup runs every root through path.resolve(cwd, value), so the fake world's
  // root must already be host-absolute: a bare '/consumer/My Project' is
  // drive-relative on Windows and would never match the fake's isDirectory.
  const consumerRoot = path.resolve(config.consumerRoot ?? '/consumer/My Project');
  const clock = { t: 0 };
  const printed: string[] = [];
  const asked: string[] = [];
  const commands: RecordedCommand[] = [];
  const fileReads: string[] = [];
  const callOrder: string[] = [];
  const initCalls: InitArgs[] = [];
  const skillCalls: SkillRequest[] = [];
  const verifyCalls: FakeWorld['verifyCalls'] = [];
  const which: Record<string, string | null> = {
    docker: '/usr/local/bin/docker',
    psql: '/usr/bin/psql',
    lsof: '/usr/sbin/lsof',
    git: '/usr/bin/git',
    npm: '/usr/bin/npm',
    claude: '/opt/claude',
    codex: null,
    ...config.which,
  };
  let readinessAttempts = 0;
  const durations = config.commandDurations ?? {};

  const respond = (command: string, args: readonly string[]): SetupCommandResult => {
    const executable = path.basename(command).replace(/\.exe$/i, '');
    const key = `${command} ${args.join(' ')}`;
    const durationKey = Object.keys(durations).find((k) => key.startsWith(k));
    if (durationKey !== undefined) clock.t += durations[durationKey];
    if (executable === 'docker' && args[0] === 'version') {
      return config.daemonDown === true
        ? { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }
        : { status: 0, stdout: '27.0\n', stderr: '' };
    }
    if (executable === 'docker' && args[0] === 'ps') {
      return { status: 0, stdout: config.containerRunning === true ? 'mai-brain-pg\n' : '', stderr: '' };
    }
    if (executable === 'docker' && args[0] === 'compose') {
      return config.composeFails === true
        ? { status: 1, stdout: '', stderr: 'port is already allocated' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (executable === 'docker' && args[0] === 'exec' && args.includes('pg_isready')) {
      readinessAttempts += 1;
      const readyAfter = config.readyAfterAttempts ?? 1;
      return readinessAttempts >= readyAfter
        ? { status: 0, stdout: 'accepting connections\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'no response' };
    }
    if (command === '/usr/sbin/lsof' || command === 'lsof') {
      return { status: 0, stdout: 'postgres  4242 someoneelse ...\n', stderr: '' };
    }
    if (executable === 'psql' || (executable === 'docker' && args[0] === 'exec' && args.includes('psql'))) {
      const stdin = '';
      void stdin;
      const isAdmin = args.includes('postgres') && !args.includes('mai_brain');
      const last = commands[commands.length - 1];
      const sql = last?.stdin ?? '';
      if (sql.includes('pg_database')) {
        return { status: 0, stdout: config.dbMissing === true ? '' : '1\n', stderr: '' };
      }
      if (sql.includes('information_schema')) {
        return { status: 0, stdout: config.schemaMissing === true ? '' : '1\n', stderr: '' };
      }
      if (config.failMigration !== undefined && sql.includes(`-- ${config.failMigration}`)) {
        return { status: 1, stdout: '', stderr: `ERROR near line 1 of ${config.failMigration}` };
      }
      void isAdmin;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args.includes('--show-toplevel')) {
      return config.consumerIsGit === false
        ? { status: 128, stdout: '', stderr: 'not a git repository' }
        : { status: 0, stdout: `${consumerRoot}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: `${config.headShort ?? 'abc1234'}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('status')) {
      return { status: 0, stdout: config.dirtyInputs ?? '', stderr: '' };
    }
    if (command === 'npm' && args.join(' ') === '--prefix frontend ci') {
      return config.frontendInstallFails === true
        ? { status: 1, stdout: '', stderr: 'registry unavailable' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'npm' && args.join(' ') === '--prefix frontend run build') {
      return config.frontendBuildFails === true
        ? { status: 1, stdout: '', stderr: 'frontend build failed' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'npm' && args.join(' ') === 'run build') {
      return config.buildFails === true
        ? { status: 1, stdout: '', stderr: 'TS1000: broken' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'npm' && args[0] === 'install') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const environment: SetupEnvironment = {
    values: { MAI_DB_URL: SAFE_DB, ...config.env },
    preFileAuthority: Object.freeze({ ...(config.preFileAuthority ?? {}) }),
  };
  const answers = [...(config.answers ?? [])];
  const migrationEntries = config.migrationEntries ?? [
    '2026-01-02-second.sql',
    '2026-01-01-first.sql',
    '2026-01-01-first.rollback.sql',
    'README.md',
  ];

  const io: SetupIO = {
    loadEnvironment: (root: string) => {
      callOrder.push('loadEnvironment');
      if (config.envError !== undefined) {
        throw new SetupError(`Setup failed at [1/8] Preflight: cannot read ${path.join(root, '.env')} (${config.envError}). Fix the file permissions or contents, then rerun`);
      }
      return environment;
    },
    runInit: async (args: InitArgs): Promise<InitResult> => {
      callOrder.push('runInit');
      initCalls.push(args);
      if (config.runInitError !== undefined) throw config.runInitError;
      return {
        slug: args.slug,
        root: args.root,
        repos: args.repos,
        harnesses: args.harnesses ?? [],
        summary: [],
        verification: { slug: args.slug, ok: true, shared: [], repos: [] },
      };
    },
    runSkills: async (request: SkillRequest): Promise<SkillRunResult> => {
      callOrder.push('runSkills');
      skillCalls.push(request);
      return {
        ok: config.skillsOk !== false,
        action: request.action,
        targets: [],
        items: [],
        notes: config.skillsOk === false ? ['drifted: plan-review'] : [],
      };
    },
    verifyProject: async (slug, opts): Promise<ProjectVerification> => {
      callOrder.push('verifyProject');
      verifyCalls.push({ slug, opts });
      return {
        slug,
        ok: config.verifyOk !== false,
        shared: config.verifyOk === false ? [{ name: 'claude skills', ok: false, detail: 'drifted' }] : [],
        repos: [],
      };
    },
    cwd: () => consumerRoot,
    isTTY: config.isTTY ?? false,
    print: (line) => {
      printed.push(line);
      callOrder.push(`print:${line.slice(0, 5)}`);
    },
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    whichCommand: (name) => {
      callOrder.push(`which:${name}`);
      return which[name] ?? null;
    },
    describeTcpListener: async () => config.listenerDescription === undefined
      ? 'postgres 4242 someoneelse' : config.listenerDescription,
    runCommand: (command, args, options) => {
      commands.push({ command, args: [...args], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env, stdin: options.stdin, at: clock.t });
      callOrder.push(`run:${command} ${args[0] ?? ''}`);
      return respond(command, args);
    },
    probeTcpPort: async () => config.portBusy === true,
    fileExists: (p) => {
      if (p.endsWith(path.join('build', 'index.js'))) return config.buildEntryExists !== false;
      if (p.endsWith(path.join('frontend', 'dist', 'index.html'))) return config.frontendDistPresent === true;
      return false;
    },
    isDirectory: (p) => {
      if (p === consumerRoot) return true;
      if (p.endsWith('node_modules')) return config.nodeModulesPresent !== false;
      if (p.endsWith('.git')) return true;
      if (p === path.join(consumerRoot, '.claude')) return config.claudeDirInRoot === true;
      if (p === path.join(consumerRoot, '.codex')) return config.codexDirInRoot === true;
      return false;
    },
    readFile: (p) => {
      fileReads.push(p);
      if (p.endsWith('build-info.json')) return config.stampText === undefined ? VALID_STAMP : config.stampText;
      if (p.endsWith('schema.sql')) return config.schemaFileMissing === true ? null : '-- schema.sql\nCREATE TABLE projects();\n';
      if (p.includes('migrations')) return path.basename(p) === config.missingMigration
        ? null : `-- ${path.basename(p)}\nSELECT 1;\n`;
      return null;
    },
    writeFile: () => {},
    mkdir: () => {},
    readdir: (p) => (p.includes('migrations') ? migrationEntries : []),
  };
  return { io, consumerRoot, printed, asked, commands, fileReads, callOrder, initCalls, skillCalls, verifyCalls, clock };
}

const STAGE_LINE_1 = `[1/8] ${'Preflight'.padEnd(15)}Checking Node, checkout and reserved ports…`;

describe('pure helpers', () => {
  it('assertNode24 accepts 24 only', () => {
    expect(() => assertNode24('24.19.0')).not.toThrow();
    expect(() => assertNode24('20.20.0')).toThrow(/\[1\/8\] Preflight/);
  });

  it('assertSafeBrainRoot rejects cache roots and non-checkouts', () => {
    // assertSafeBrainRoot splits on path.sep, so the roots must carry the host separator.
    const cacheRoot = path.resolve('/Users/x/.npm/_npx/abc/node_modules/mai-mcp');
    const checkout = path.resolve('/Users/x/mai-mcp');
    expect(() => assertSafeBrainRoot(cacheRoot, true)).toThrow(/package cache/);
    expect(() => assertSafeBrainRoot(checkout, false)).toThrow(/\.git/);
    expect(() => assertSafeBrainRoot(checkout, true)).not.toThrow();
  });

  it('parseDatabaseUrl refuses 54333 and invalid identifiers', () => {
    expect(() => parseDatabaseUrl('postgresql://p@127.0.0.1:54333/legacy')).toThrow(/54333/);
    expect(() => parseDatabaseUrl('not a url')).toThrow(/not a valid URL/);
    expect(() => parseDatabaseUrl('postgresql://p@127.0.0.1:54334/bad-name')).toThrow(/identifier/);
    const parsed = parseDatabaseUrl(SAFE_DB);
    expect(parsed).toMatchObject({ host: '127.0.0.1', port: '54334', user: 'postgres', database: 'mai_brain' });
  });

  it('deriveProjectIdentity slugifies basenames', () => {
    expect(deriveProjectIdentity('My Repo')).toBe('my-repo');
    expect(deriveProjectIdentity('__Weird--Name__')).toBe('weird-name');
    expect(deriveProjectIdentity('1app')).toBe('1app');
  });

  it('resolveSetupRoot expands home and resolves relative roots against the consumer cwd', () => {
    const savedHome = process.env.HOME;
    // resolveSetupRoot returns path.resolve output, so both the inputs and the
    // expectations are built with path — POSIX literals are not absolute on Windows.
    const home = path.resolve('/home/operator');
    const cwd = path.resolve('/consumer/My Project');
    process.env.HOME = home;
    try {
      expect(resolveSetupRoot('.', cwd)).toBe(cwd);
      expect(resolveSetupRoot('../Other', cwd)).toBe(path.resolve(cwd, '../Other'));
      expect(resolveSetupRoot('~/repo', cwd)).toBe(path.join(home, 'repo'));
      expect(() => resolveSetupRoot('~someone/repo', path.resolve('/consumer'))).toThrow(/~user/);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it('buildNeeded covers every branch of the SHA/dirty predicate', () => {
    const base = { buildEntryExists: true, stampText: VALID_STAMP, headShort: 'abc1234', dirtyInputStatus: '' };
    expect(buildNeeded(base).needed).toBe(false);
    expect(buildNeeded({ ...base, buildEntryExists: false }).reason).toContain('missing');
    expect(buildNeeded({ ...base, stampText: '{broken' }).reason).toContain('malformed');
    expect(buildNeeded({ ...base, stampText: null }).reason).toContain('malformed');
    expect(
      buildNeeded({ ...base, stampText: VALID_STAMP.replace('abc1234', 'unknown') }).reason
    ).toContain('no git identity');
    expect(buildNeeded({ ...base, headShort: 'docsonly' }).reason).toContain('behind HEAD');
    expect(buildNeeded({ ...base, dirtyInputStatus: ' M src/index.ts\n' }).reason).toContain('uncommitted');
  });

  it('forwardMigrations sorts, excludes rollbacks, and rejects duplicates', () => {
    expect(forwardMigrations(['b.sql', 'a.sql', 'a.rollback.sql', 'notes.md'])).toEqual(['a.sql', 'b.sql']);
    expect(() => forwardMigrations(['a.sql', 'a.sql'])).toThrow(/duplicate migration/);
  });
});

describe('parseSetupArgs', () => {
  it('accepts every documented enum and both booleans', () => {
    expect(parseSetupArgs(['--slug', 's', '--root', '/r', '--harness', 'all', '--llm', 'codex-cli', '--embeddings', 'local', '--yes', '--no-skills'])).toEqual({
      slug: 's', root: '/r', harness: 'all', llm: 'codex-cli', embeddings: 'local', yes: true, noSkills: true,
    });
    expect(parseSetupArgs(['--llm', 'none']).llm).toBe('none');
    expect(parseSetupArgs(['--embeddings', 'none']).embeddings).toBe('none');
    expect(parseSetupArgs(['--harness', 'claude-code']).harness).toBe('claude-code');
    expect(parseSetupArgs(['--harness', 'codex']).harness).toBe('codex');
  });

  it.each([
    [['--llm'], /requires a value/],
    [['--llm', 'gpt'], /--llm must be/],
    [['--harness', 'cursor'], /--harness must be/],
    [['--embeddings', 'cloud'], /--embeddings must be/],
    [['--slug', 'a', '--slug', 'b'], /only be given once/],
    [['--wat'], /unknown setup flag/],
  ])('rejects %j with usage', (argv, message) => {
    expect(() => parseSetupArgs(argv)).toThrow(message);
    expect(() => parseSetupArgs(argv)).toThrow(/usage: mai setup/);
  });
});

describe('runSetup — ordered stages and outcomes', () => {
  it('prints the exact eight ordered stages with the env loader as the first Preflight operation', async () => {
    const world = makeFake({ containerRunning: true });
    const result = await runSetup({ yes: true }, world.io);

    expect(world.printed[0]).toBe(STAGE_LINE_1);
    // The stage line prints FIRST; the env loader is the first operation after.
    expect(world.callOrder[0]).toBe('print:[1/8]');
    expect(world.callOrder[1]).toBe('loadEnvironment');
    const stageLines = world.printed.filter((l) => /^\[\d\/8\]/.test(l));
    expect(stageLines).toEqual(STAGES.map((s, i) => `[${i + 1}/8] ${s.label.padEnd(15)}${s.message}`));
    expect(world.printed.some((l) => l.startsWith('  ✓'))).toBe(true);
    expect(world.printed.some((l) => l.startsWith('  ↷'))).toBe(true); // reused container
    expect(world.printed.join('\n')).toContain('mai-mcp setup complete');
    expect(result.slug).toBe('my-project');
    expect(result.databaseReady).toBe(true);
  });

  it('interactive and --yes share one flow: same stages, questions only without --yes', async () => {
    const interactive = makeFake({ containerRunning: true, isTTY: true, answers: ['edited-slug', ''] });
    await runSetup({}, interactive.io);
    expect(interactive.asked.length).toBe(2);
    expect(interactive.initCalls[0].slug).toBe('edited-slug');
    const stageLines = interactive.printed.filter((l) => /^\[\d\/8\]/.test(l));
    expect(stageLines).toHaveLength(8);

    const yes = makeFake({ containerRunning: true });
    await runSetup({ yes: true }, yes.io);
    expect(yes.asked).toHaveLength(0);
  });

  it('persists an interactive relative root as an absolute existing path', async () => {
    const world = makeFake({ containerRunning: true, isTTY: true, answers: ['', '.'] });
    const result = await runSetup({}, world.io);
    expect(result.root).toBe(world.consumerRoot);
    expect(world.initCalls[0].root).toBe(world.consumerRoot);
  });

  it('non-TTY without --yes refuses at Project before any mutation', async () => {
    const world = makeFake({ containerRunning: true, isTTY: false });
    await expect(runSetup({}, world.io)).rejects.toThrow(/\[5\/8\] Project: not a terminal/);
    expect(world.initCalls).toHaveLength(0);
    expect(world.printed.join('\n')).not.toContain('setup complete');
  });

  it('an injected failure at every stage names the stage and never prints success', async () => {
    const cases: Array<{ config: FakeConfig; stage: number }> = [
      { config: { envError: 'EACCES' }, stage: 1 },
      { config: { daemonDown: true }, stage: 2 },
      { config: { containerRunning: true, failMigration: '2026-01-01-first.sql' }, stage: 3 },
      { config: { containerRunning: true, buildEntryExists: false, buildFails: true }, stage: 4 },
      { config: { containerRunning: true, isTTY: false }, stage: 5 }, // no --yes
      { config: { containerRunning: true, runInitError: new Error('init exploded') }, stage: 6 },
      { config: { containerRunning: true, skillsOk: false }, stage: 7 },
      { config: { containerRunning: true, verifyOk: false }, stage: 8 },
    ];
    for (const { config, stage } of cases) {
      const world = makeFake(config);
      const args = stage === 5 ? {} : { yes: true };
      let message = '';
      try {
        await runSetup(args, world.io);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain(`[${stage}/8]`);
      if (stage === 6) expect(message).toContain('init exploded');
      expect(world.printed.join('\n')).not.toContain('setup complete');
    }
  });
});

describe('runSetup — database stage matrix', () => {
  it('docker missing and daemon down have distinct failures', async () => {
    const missing = makeFake({ which: { docker: null } });
    await expect(runSetup({ yes: true }, missing.io)).rejects.toThrow(/Docker is not installed/);
    const down = makeFake({ daemonDown: true });
    await expect(runSetup({ yes: true }, down.io)).rejects.toThrow(/daemon is not running/);
  });

  it('a foreign listener with lsof names the holder and stops', async () => {
    const world = makeFake({ portBusy: true });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/held by a foreign process/);
    expect(world.commands.some((c) => c.command === 'docker' && c.args[0] === 'compose')).toBe(false);
  });

  it('a busy port with unavailable diagnostics returns the portable recovery and no Docker mutation', async () => {
    const world = makeFake({ portBusy: true, listenerDescription: null });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow('port 54334 is busy; stop its listener, then rerun');
    expect(world.commands.some((c) => c.command === 'docker' && c.args[0] === 'compose')).toBe(false);
  });

  it('listener absent starts compose; owned container is reused', async () => {
    const fresh = makeFake({ containerRunning: false, portBusy: false });
    await runSetup({ yes: true }, fresh.io);
    expect(fresh.commands.some((c) => c.command === 'docker' && c.args.join(' ') === 'compose up -d')).toBe(true);

    const owned = makeFake({ containerRunning: true });
    await runSetup({ yes: true }, owned.io);
    expect(owned.commands.some((c) => c.args[0] === 'compose')).toBe(false);
    expect(owned.printed.join('\n')).toContain('reusing the running mai-brain-pg container');
  });

  it('readiness holds one 60s budget: immediate first poll, remaining-budget child timeouts, bounded total', async () => {
    const world = makeFake({
      containerRunning: true,
      readyAfterAttempts: 999,
      commandDurations: { 'docker exec mai-brain-pg pg_isready': 7_000 },
    });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/ready within 60 seconds/);
    const polls = world.commands.filter((c) => c.args.includes('pg_isready'));
    expect(polls.length).toBeGreaterThan(1);
    expect(polls[0].at).toBe(0); // immediate first poll
    for (const poll of polls) {
      expect(poll.timeoutMs).toBe(60_000 - poll.at); // exactly the remaining budget
      expect(poll.at).toBeLessThan(60_000); // no attempt begins after the deadline
    }
    expect(world.clock.t).toBeLessThanOrEqual(60_000 + 7_000); // last command may finish at the edge
  });
});

describe('runSetup — schema stage', () => {
  it('host psql: exact argv, redacted env, SQL on stdin, sorted migrations excluding rollbacks', async () => {
    const world = makeFake({ containerRunning: true, dbMissing: true, schemaMissing: true });
    await runSetup({ yes: true }, world.io);
    const psqlCalls = world.commands.filter((c) => path.basename(c.command) === 'psql');
    expect(psqlCalls.length).toBeGreaterThanOrEqual(5);
    for (const call of psqlCalls) {
      expect(call.args.slice(0, 3)).toEqual(['--no-psqlrc', '--set', 'ON_ERROR_STOP=1']);
      expect(call.env?.PGPASSWORD).toBe('postgres');
      expect(call.args.join(' ')).not.toContain('postgres:postgres@'); // no secret in argv
      expect(typeof call.stdin).toBe('string');
    }
    const createCall = psqlCalls.find((c) => c.stdin?.includes('CREATE DATABASE'));
    expect(createCall?.args).toContain('postgres');
    const schemaCall = psqlCalls.find((c) => c.stdin?.includes('-- schema.sql'));
    expect(schemaCall?.args).toContain('mai_brain');
    const migrationCalls = psqlCalls
      .map((c) => c.stdin ?? '')
      .filter((s) => s.includes('-- 2026-'))
      .map((s) => s.match(/-- (\S+)/)?.[1]);
    expect(migrationCalls).toEqual(['2026-01-01-first.sql', '2026-01-02-second.sql']);
  });

  it('container mode translates the compose URL and refuses custom URLs without host psql', async () => {
    const world = makeFake({ which: { psql: null }, containerRunning: true });
    await runSetup({ yes: true }, world.io);
    const containerPsql = world.commands.filter((c) => path.basename(c.command) === 'docker' && c.args.includes('psql'));
    expect(containerPsql.length).toBeGreaterThan(0);
    for (const call of containerPsql) {
      expect(call.args.slice(0, 3)).toEqual(['exec', '-i', 'mai-brain-pg']);
      expect(call.args).toContain('--username');
      expect(call.args.join(' ')).not.toContain('54334'); // never forward the host port
      expect(call.args.join(' ')).not.toContain('127.0.0.1'); // or hostname
      expect(call.env?.PGPASSWORD).toBeUndefined(); // local socket auth, no secret
    }

    const custom = makeFake({
      which: { psql: null },
      containerRunning: true,
      env: { MAI_DB_URL: 'postgresql://me:pw@db.example.com:5433/other' },
    });
    await expect(runSetup({ yes: true }, custom.io)).rejects.toThrow(
      /install psql or use the compose-managed MAI_DB_URL/i
    );
  });

  it('a failing migration names the file', async () => {
    const world = makeFake({ containerRunning: true, failMigration: '2026-01-02-second.sql' });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/migration 2026-01-02-second\.sql failed/);
  });
});

describe('runSetup — build stage branches', () => {
  it('skips when the stamp matches HEAD with clean inputs; rebuilds after a docs-only HEAD advance', async () => {
    const current = makeFake({ containerRunning: true });
    await runSetup({ yes: true }, current.io);
    expect(current.commands.some((c) => c.command === 'npm' && c.args.join(' ') === 'run build')).toBe(false);
    expect(current.printed.join('\n')).toContain('build is current');

    const docsOnly = makeFake({ containerRunning: true, headShort: 'newhead' });
    await runSetup({ yes: true }, docsOnly.io);
    expect(docsOnly.commands.some((c) => c.command === 'npm' && c.args.join(' ') === 'run build')).toBe(true);
    expect(docsOnly.printed.join('\n')).toContain('behind HEAD');
  });

  it('rebuilds on missing entry, malformed/unknown stamp, and dirty inputs; checks the exact input path set', async () => {
    for (const config of [
      { buildEntryExists: false },
      { stampText: '{nope' },
      { stampText: VALID_STAMP.replace('abc1234', 'unknown') },
      { dirtyInputs: '?? src/untracked.ts\n' },
    ] satisfies FakeConfig[]) {
      const world = makeFake({ containerRunning: true, ...config });
      await runSetup({ yes: true }, world.io);
      expect(world.commands.some((c) => c.command === 'npm' && c.args.join(' ') === 'run build')).toBe(true);
    }
    const world = makeFake({ containerRunning: true });
    await runSetup({ yes: true }, world.io);
    const status = world.commands.find((c) => c.command === 'git' && c.args.includes('status'));
    expect(status?.args).toEqual([
      'status', '--porcelain', '--untracked-files=all', '--',
      'src', 'scripts/stamp-build.mjs', 'package.json', 'package-lock.json', 'tsconfig.json',
    ]);
  });

  it('installs dependencies only when node_modules is absent', async () => {
    const world = makeFake({ containerRunning: true, nodeModulesPresent: false });
    await runSetup({ yes: true }, world.io);
    expect(world.commands.some((c) => c.command === 'npm' && c.args[0] === 'install')).toBe(true);
  });
});

describe('runSetup — project, harnesses, skills, verify', () => {
  it('slugifies the git toplevel and warns (without failing) on a non-git cwd', async () => {
    const world = makeFake({ containerRunning: true, consumerIsGit: false, consumerRoot: '/plain/Dir Name' });
    const result = await runSetup({ yes: true }, world.io);
    expect(result.slug).toBe('dir-name');
    expect(world.printed.some((l) => l.startsWith('  ! ') && l.includes('not a git repository'))).toBe(true);
  });

  it('explicit harness wins over detection; detection installs both when both present', async () => {
    const explicit = makeFake({ containerRunning: true, codexDirInRoot: true });
    await runSetup({ yes: true, harness: 'codex' }, explicit.io);
    expect(explicit.initCalls[0].harnesses).toEqual(['codex']);

    const both = makeFake({ containerRunning: true, which: { codex: '/opt/codex' } });
    await runSetup({ yes: true }, both.io);
    expect(both.initCalls[0].harnesses).toEqual(['claude-code', 'codex']);
  });

  it('no detection never asks; under --yes it fails with the explicit --harness recovery', async () => {
    const world = makeFake({ containerRunning: true, which: { claude: null, codex: null } });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/--harness claude-code\|codex\|all/);
    expect(world.asked).toHaveLength(0);
    expect(world.initCalls).toHaveLength(0);
  });

  it('calls io.runInit exactly once with the exact deferred payload and captured authority', async () => {
    const world = makeFake({
      containerRunning: true,
      preFileAuthority: { provider: 'codex-cli', summary: '1' },
    });
    await runSetup({ yes: true, llm: 'codex-cli', embeddings: 'none' }, world.io);
    expect(world.initCalls).toHaveLength(1);
    const call = world.initCalls[0];
    expect(call).toMatchObject({
      slug: 'my-project',
      root: world.consumerRoot,
      repos: [world.consumerRoot],
      draftTopics: false,
      harnesses: ['claude-code'],
      llm: 'codex-cli',
      embeddings: 'none',
      yes: true,
      printSummary: false,
      sharedSkillsVerification: 'deferred',
    });
    expect(call.preFileLlmAuthority).toEqual({ provider: 'codex-cli', summary: '1' });
  });

  it('skills run per detected target; --no-skills skips them but never weakens the final verify', async () => {
    const both = makeFake({ containerRunning: true, which: { codex: '/opt/codex' } });
    await runSetup({ yes: true }, both.io);
    expect(both.skillCalls).toEqual([{ action: 'install', target: 'all', codexScope: 'user' }]);

    const skipped = makeFake({ containerRunning: true });
    const result = await runSetup({ yes: true, noSkills: true }, skipped.io);
    expect(skipped.skillCalls).toHaveLength(0);
    expect(result.skills).toBeNull();
    expect(skipped.verifyCalls).toEqual([{ slug: 'my-project', opts: { sharedSkills: 'required' } }]);
  });

  it('the final verification is always the required policy and failure prints no success', async () => {
    const world = makeFake({ containerRunning: true, verifyOk: false });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/\[8\/8\] Verify: verification failed/);
    expect(world.verifyCalls[0].opts.sharedSkills).toBe('required');
    expect(world.printed.join('\n')).not.toContain('setup complete');
  });

  it('a refused skill install fails the Skills stage with the repair recovery', async () => {
    const world = makeFake({ containerRunning: true, skillsOk: false });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/\[7\/8\] Skills: skill installation refused/);
  });
});

describe('Plan 32a Task 3 setup portability cases', () => {
  it('discovers a Windows Docker .cmd executable', async () => {
    const world = makeFake({ containerRunning: true, which: { docker: 'C:\\Program Files\\Docker\\docker.cmd' } });
    await runSetup({ yes: true }, world.io);
    expect(world.callOrder).toContain('which:docker');
  });

  it('includes a Windows foreign busy-port description and refuses compose', async () => {
    const description = 'PID 4120 docker-desktop.exe';
    const world = makeFake({ portBusy: true, listenerDescription: description });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(description);
    expect(world.commands.some(call => call.args[0] === 'compose')).toBe(false);
  });

  it('still refuses a busy port when diagnostics are unavailable', async () => {
    const world = makeFake({ portBusy: true, listenerDescription: null });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow('port 54334 is busy; stop its listener, then rerun');
  });

  it('proceeds when the compose container is the verified port owner', async () => {
    const world = makeFake({ containerRunning: true, portBusy: true });
    await expect(runSetup({ yes: true }, world.io)).resolves.toMatchObject({ databaseReady: true });
    expect(world.printed.join('\n')).toContain('reusing the running mai-brain-pg container');
  });

  it('contains no lsof dependency or recovery on Windows', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src', 'scripts', 'setup.ts'), 'utf8');
    expect(source).not.toMatch(/\blsof\b/i);
  });

  it('preserves a consumer path containing spaces as one argv value', async () => {
    const world = makeFake({ containerRunning: true, consumerRoot: '/consumer/path with spaces' });
    await runSetup({ yes: true }, world.io);
    expect(world.consumerRoot).toContain('path with spaces');
    expect(world.initCalls[0].root).toBe(world.consumerRoot);
    expect(world.initCalls[0].repos).toEqual([world.consumerRoot]);
  });

  it('preserves a consumer path containing an ampersand as data', async () => {
    const world = makeFake({ containerRunning: true, consumerRoot: '/consumer/research & development' });
    await runSetup({ yes: true }, world.io);
    expect(world.consumerRoot).toContain('research & development');
    expect(world.initCalls[0].root).toBe(world.consumerRoot);
  });

  it('preserves inherited provider authority after loading .env', async () => {
    const authority = { provider: 'codex-cli', summary: '0' };
    const world = makeFake({ containerRunning: true, preFileAuthority: authority, env: { MAI_LLM_PROVIDER: 'claude-code' } });
    await runSetup({ yes: true }, world.io);
    expect(world.initCalls[0].preFileLlmAuthority).toEqual(authority);
  });

  it('uses container psql when no host client exists', async () => {
    const world = makeFake({ containerRunning: true, which: { psql: null } });
    await runSetup({ yes: true }, world.io);
    expect(world.commands.some(call => path.basename(call.command) === 'docker' && call.args.includes('psql'))).toBe(true);
  });

  it('executes the resolved host psql .exe path', async () => {
    const executable = 'C:\\PostgreSQL\\bin\\psql.exe';
    const world = makeFake({ containerRunning: true, which: { psql: executable } });
    await runSetup({ yes: true }, world.io);
    expect(world.commands.some(call => call.command === executable)).toBe(true);
  });

  it('prints ordinary dashboard start plus supported opt-in persistence guidance', async () => {
    const world = makeFake({ containerRunning: true });
    await runSetup({ yes: true }, world.io);
    expect(world.printed).toContain('  3. start dashboard: mai dashboard start');
    const command = dashboardPersistenceSetupCommand(path.resolve(REPO_ROOT));
    if (command === null) {
      expect(world.printed.join('\n')).not.toContain('enable login persistence');
    } else {
      expect(world.printed).toContain(`     or enable login persistence (opt-in): ${command}`);
    }
  });

  it('renders copy-safe persistence commands for macOS and Windows only', () => {
    expect(dashboardPersistenceSetupCommand("/Users/test/Mai's Brain", 'darwin')).toBe(
      `/bin/bash '/Users/test/Mai'\"'\"'s Brain/scripts/mai-brain-web-launchd.sh' install`,
    );
    expect(dashboardPersistenceSetupCommand("C:\\Users\\test\\Mai's Brain", 'win32')).toBe(
      `& 'C:\\Users\\test\\Mai''s Brain\\scripts\\windows\\install-dashboard.ps1' -Action Install -CheckoutRoot 'C:\\Users\\test\\Mai''s Brain'`,
    );
    expect(dashboardPersistenceSetupCommand('/srv/mai-mcp', 'linux')).toBeNull();
  });

  it('executes the macOS persistence command from a fresh PATH without interpreting path metacharacters', async () => {
    // POSIX-only premise: the command under test is the darwin one and it is run through /bin/sh, which Windows has no equivalent of.
    if (process.platform === 'win32') return;
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'mai-setup-persist-'));
    const checkout = path.join(scratch, "brain space's;touch pwned;$(touch pwned2)");
    const launcher = path.join(checkout, 'scripts', 'mai-brain-web-launchd.sh');
    const log = path.join(scratch, 'argv.log');
    try {
      mkdirSync(path.dirname(launcher), { recursive: true });
      writeFileSync(launcher, `#!/bin/bash\n/usr/bin/printf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
      const command = dashboardPersistenceSetupCommand(checkout, 'darwin');
      if (command === null) throw new Error('macOS persistence command missing');
      await run('/bin/sh', ['-c', command], { cwd: scratch, env: { PATH: '/nonexistent' } });
      expect(readFileSync(log, 'utf8')).toBe('install\n');
      expect(existsSync(path.join(scratch, 'pwned'))).toBe(false);
      expect(existsSync(path.join(scratch, 'pwned2'))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('is idempotent across a successful rerun', async () => {
    const first = makeFake({ containerRunning: true, frontendDistPresent: true });
    const second = makeFake({ containerRunning: true, frontendDistPresent: true });
    await runSetup({ yes: true }, first.io);
    await runSetup({ yes: true }, second.io);
    expect(second.printed.join('\n')).toContain('setup complete');
    expect(second.commands.some(call => call.args.join(' ') === 'compose up -d')).toBe(false);
  });

  it('builds dashboard assets when frontend/dist/index.html is absent', async () => {
    const world = makeFake({ containerRunning: true });
    await runSetup({ yes: true }, world.io);
    expect(world.commands.filter(call => call.command === 'npm' && call.args[1] === 'frontend').map(call => call.args))
      .toEqual([['--prefix', 'frontend', 'ci'], ['--prefix', 'frontend', 'run', 'build']]);
  });

  it('skips the dashboard build when frontend/dist/index.html is present', async () => {
    const world = makeFake({ containerRunning: true, frontendDistPresent: true });
    await runSetup({ yes: true }, world.io);
    expect(world.commands.some(call => call.args.includes('frontend'))).toBe(false);
  });

  it('warns on frontend build failure and continues to Harnesses', async () => {
    const world = makeFake({ containerRunning: true, frontendBuildFails: true });
    await expect(runSetup({ yes: true }, world.io)).resolves.toMatchObject({ databaseReady: true });
    expect(world.printed.some(line => line.startsWith('  ! ') && line.includes('dashboard'))).toBe(true);
    expect(world.callOrder).toContain('runInit');
  });

  it('names the manual dashboard build command when the build is skipped or failed', async () => {
    for (const config of [{ frontendDistPresent: true }, { frontendBuildFails: true }]) {
      const world = makeFake({ containerRunning: true, ...config });
      await runSetup({ yes: true }, world.io);
      expect(world.printed).toContain('  dashboard build: npm run build:web');
    }
  });

  it('passes the complete SetupIO fake directly to ensureDatabase', async () => {
    const world = makeFake({ containerRunning: true, dbMissing: true, schemaMissing: true });
    const result = await ensureDatabase({ checkoutRoot: REPO_ROOT, dbUrl: SAFE_DB }, world.io);
    expect(result).toMatchObject({ databaseCreated: true, schemaApplied: true, mode: 'host' });
    expect(world.commands.map(call => ({ command: call.command, stdin: call.stdin }))).toEqual([
      { command: '/usr/bin/psql', stdin: "SELECT 1 FROM pg_database WHERE datname = 'mai_brain';\n" },
      { command: '/usr/bin/psql', stdin: 'CREATE DATABASE "mai_brain";\n' },
      { command: '/usr/bin/psql', stdin: "SELECT 1 FROM information_schema.tables WHERE table_name = 'projects';\n" },
      { command: '/usr/bin/psql', stdin: '-- schema.sql\nCREATE TABLE projects();\n' },
      { command: '/usr/bin/psql', stdin: '-- 2026-01-01-first.sql\nSELECT 1;\n' },
      { command: '/usr/bin/psql', stdin: '-- 2026-01-02-second.sql\nSELECT 1;\n' },
    ]);
    expect(world.fileReads).toEqual([
      path.join(REPO_ROOT, 'db', 'schema.sql'),
      path.join(REPO_ROOT, 'db', 'migrations', '2026-01-01-first.sql'),
      path.join(REPO_ROOT, 'db', 'migrations', '2026-01-02-second.sql'),
    ]);
  });

  it('refuses an absent schema before application and never reaches Build', async () => {
    const world = makeFake({ containerRunning: true, dbMissing: true, schemaMissing: true, schemaFileMissing: true });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/db\/schema\.sql is missing/);
    expect(world.commands.some(call => call.stdin?.includes('CREATE TABLE'))).toBe(false);
    expect(world.printed.some(line => line.includes('[4/8]'))).toBe(false);
  });

  it('refuses an absent migration without applying it or later migrations and never reaches Build', async () => {
    const world = makeFake({
      containerRunning: true,
      missingMigration: '2026-01-02-second.sql',
      migrationEntries: ['2026-01-01-first.sql', '2026-01-02-second.sql', '2026-01-03-third.sql'],
    });
    await expect(runSetup({ yes: true }, world.io)).rejects.toThrow(/cannot read migration 2026-01-02-second\.sql/);
    const applied = world.commands.map(call => call.stdin ?? '').filter(sql => sql.includes('-- 2026-'));
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('2026-01-01-first.sql');
    expect(world.printed.some(line => line.includes('[4/8]'))).toBe(false);
  });
});

describe('structural gate: source setup is a Node-24 bootstrap', () => {
  it('source setup has exactly one generated non-builtin runtime dependency', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src', 'scripts', 'setup.ts'), 'utf8');
    const file = ts.createSourceFile('setup.ts', source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) continue;
        if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new Error('nonliteral import');
        imports.push(statement.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new Error('nonliteral export');
        imports.push(statement.moduleSpecifier.text);
      }
    }
    expect(imports.length).toBeGreaterThan(5);
    expect(imports.filter(specifier => !specifier.startsWith('node:')))
      .toEqual(['./setup-runtime.generated.mjs']);
  });
});

describe('route parity — real source and compiled entry, rigged to fail in Preflight', () => {
  function makeScratchCheckout(): string {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'mai-setup-route-'));
    mkdirSync(path.join(scratch, '.git'));
    mkdirSync(path.join(scratch, 'src', 'scripts'), { recursive: true });
    mkdirSync(path.join(scratch, 'build', 'scripts'), { recursive: true });
    cpSync(path.join(REPO_ROOT, 'src', 'scripts', 'setup.ts'), path.join(scratch, 'src', 'scripts', 'setup.ts'));
    cpSync(path.join(REPO_ROOT, 'build', 'entry.js'), path.join(scratch, 'build', 'entry.js'));
    cpSync(path.join(REPO_ROOT, 'build', 'scripts', 'setup.js'), path.join(scratch, 'build', 'scripts', 'setup.js'));
    for (const directory of ['src', 'build']) {
      for (const name of ['setup-runtime.generated.mjs', 'setup-runtime.generated.d.mts', 'setup-runtime.LICENSE.txt']) {
        cpSync(path.join(REPO_ROOT, directory, 'scripts', name), path.join(scratch, directory, 'scripts', name));
      }
    }
    return scratch;
  }
  const ROUTES: Array<{ name: string; argvFor: (scratch: string) => string[] }> = [
    { name: 'source script', argvFor: (s) => [path.join(s, 'src', 'scripts', 'setup.ts'), '--yes'] },
    { name: 'checkout bin entry', argvFor: (s) => [path.join(s, 'build', 'entry.js'), 'setup', '--yes'] },
  ];

  async function spawnRoute(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      // PATH is deliberately empty of real tools: even if a rigged fixture
      // slipped past Preflight, no docker/psql/git could ever resolve.
      const r = await run(process.execPath, argv, {
        env: { PATH: '/nonexistent-mai-setup-bin', ...env },
        timeout: 30_000,
      });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      if (typeof err !== 'object' || err === null) throw err;
      if ('killed' in err && err.killed === true) {
        throw new Error(`setup route HUNG: ${argv.join(' ')}`);
      }
      const code = 'code' in err && typeof err.code === 'number' ? err.code : -1;
      const stdout = 'stdout' in err && typeof err.stdout === 'string' ? err.stdout : '';
      const stderr = 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : '';
      return { code, stdout, stderr };
    }
  }

  it.each(ROUTES)('$name: .env port 54333 is refused before Docker, Preflight line first', async ({ argvFor }) => {
    const scratch = makeScratchCheckout();
    writeFileSync(
      path.join(scratch, '.env'),
      'garbage line that is not an assignment ===\nMAI_DB_URL=postgresql://postgres:postgres@127.0.0.1:54333/mai_brain\n'
    );
    const r = await spawnRoute(argvFor(scratch));
    expect(r.code).toBe(1);
    expect(r.stdout.split('\n')[0]).toBe(STAGE_LINE_1);
    expect(r.stderr).toContain('Setup failed at [1/8] Preflight');
    expect(r.stderr).toContain('54333');
    expect(r.stdout).not.toContain('[2/8]');
  }, 60_000);

  it.each(ROUTES)('$name: an unreadable .env prints Preflight, then the path-bearing failure, no outcome', async ({ argvFor }) => {
    // POSIX-only premise: chmod 000 cannot make a file unreadable on Windows (only the read-only bit exists), so the .env would load and Preflight would pass.
    if (process.platform === 'win32') return;
    const scratch = makeScratchCheckout();
    const envFile = path.join(scratch, '.env');
    writeFileSync(envFile, 'MAI_DB_URL=postgresql://postgres:postgres@127.0.0.1:54334/mai_brain\n');
    chmodSync(envFile, 0o000);
    const r = await spawnRoute(argvFor(scratch));
    expect(r.code).toBe(1);
    expect(r.stdout.split('\n')[0]).toBe(STAGE_LINE_1);
    expect(r.stderr).toContain('Setup failed at [1/8] Preflight');
    expect(r.stderr).toContain(envFile);
    expect(r.stdout).not.toContain('  ✓');
    expect(r.stdout).not.toContain('[2/8]');
  }, 60_000);

  it.each(ROUTES)('$name: an existing process MAI_DB_URL wins over the file (missing .env default path)', async ({ argvFor }) => {
    const scratch = makeScratchCheckout();
    writeFileSync(path.join(scratch, '.env'), 'MAI_DB_URL=postgresql://postgres:postgres@127.0.0.1:54334/mai_brain\n');
    const r = await spawnRoute(argvFor(scratch), { MAI_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54333/x' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('54333'); // the inherited process value was the effective one
  }, 60_000);

  it.each(ROUTES)('$name: a bad flag fails with usage before any stage or mutation', async ({ argvFor }) => {
    const scratch = makeScratchCheckout();
    const argv = argvFor(scratch);
    const r = await spawnRoute([...argv.slice(0, -1), '--llm', 'bogus']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--llm must be');
    expect(r.stderr).toContain('usage: mai setup');
    expect(r.stdout).not.toContain('[1/8]');
  }, 60_000);
});
