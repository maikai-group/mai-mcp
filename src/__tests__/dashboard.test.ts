import { JEV_ENV_KEYS } from '../providers/runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import {
  DASHBOARD_CONTROLLER_ENV_KEYS,
  DASHBOARD_PRIVATE_ENV_KEYS,
  DASHBOARD_PROVIDER_ENV_KEYS,
  DASHBOARD_SERVER_ENV_KEYS,
  dashboardBuildIdentity,
  defaultDashboardIO,
  dashboardRun,
  dashboardStart,
  dashboardStatus,
  dashboardStatusBuild,
  dashboardStop,
  executeStop,
  isDashboardBuildIdentity,
  parseDashboardState,
  reserveStop,
  resolveHealthUrl,
  validateHealthUrl,
  type DashboardIO,
  type DashboardRunning,
  type DashboardState,
} from '../scripts/dashboard.js';
import { shouldLoadCheckoutEnv } from '../env.js';
import type { ChildHandle, ChildSpec, SignalOutcome } from '../platform/processes.js';
import { defaultProcessOps, spawnAttached as spawnPlatformAttached } from '../platform/processes.js';
import { LockReleaseError, withStateLock as withPlatformStateLock } from '../platform/locks.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUILD = 'a'.repeat(64);
const OTHER_BUILD = 'b'.repeat(64);
const LAUNCH = '11111111-1111-4111-8111-111111111111';
const OTHER_LAUNCH = '22222222-2222-4222-8222-222222222222';

function running(overrides: Partial<DashboardRunning> = {}): DashboardRunning {
  return {
    schema: 1, phase: 'running', pid: 222, birthId: 'birth-222', runnerPid: 111,
    launchId: LAUNCH, buildSha: BUILD, url: 'http://127.0.0.1:6601',
    startedAt: '2026-09-10T12:00:00.000Z', ...overrides,
  };
}

interface FakeIO extends DashboardIO {
  state: DashboardState | null;
  specs: ChildSpec[];
  detached: ChildSpec[];
  signals: Array<{ pid: number; authorized: boolean }>;
  stateReads: number;
  prepared: Array<string | undefined>;
  privateFile: string;
  buildError: Error | null;
  childExit: { code: number | null; signal: NodeJS.Signals | null };
  childSignal: SignalOutcome;
  childWait: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null;
  stateHistory: DashboardState[];
  healthUrls: string[];
  projectUrls: string[];
  healthTokens: Array<string | undefined>;
  closedLogs: number[];
  forwarded: string[];
}

function fakeIO(initial: DashboardState | null = null): FakeIO {
  const alive = new Set<number>([process.pid, 111, 222]);
  const io: FakeIO = {
    state: initial,
    specs: [], detached: [], signals: [], stateReads: 0, prepared: [], privateFile: '', buildError: null,
    childExit: { code: 0, signal: null }, childSignal: { kind: 'signalled' }, childWait: null,
    stateHistory: [], healthUrls: [], projectUrls: [], healthTokens: [], closedLogs: [], forwarded: [],
    env: { PATH: '/bin', HOME: '/home/test', MAI_PROJECT_SLUG: 'test', MAI_DB_URL: 'postgres://db' },
    now: () => new Date('2026-09-10T12:00:10.000Z'),
    randomId: () => OTHER_LAUNCH,
    preparePaths(envFile) { io.prepared.push(envFile); },
    currentBuildIdentity() { if (io.buildError) throw io.buildError; return BUILD; },
    async withStateLock(fn) { return fn(); },
    readState() { io.stateReads += 1; return io.state; },
    writeState(state) { io.state = state; io.stateHistory.push(state); },
    removeState() { io.state = null; },
    readPrivateFile() { return io.privateFile; },
    openLog: () => 9,
    closeLog(fd) { io.closedLogs.push(fd); },
    spawnAttached(spec) {
      io.specs.push(spec);
      const handle: ChildHandle = {
        pid: 222,
        async signal(signal, authorize) {
          io.forwarded.push(signal);
          const authorized = await authorize();
          if (authorized && io.childSignal.kind !== 'failed') alive.delete(222);
          return authorized ? io.childSignal : { kind: 'failed', error: new Error('authorization refused') };
        },
        async wait() {
          const exit = await (io.childWait ?? io.childExit);
          alive.delete(222);
          return exit;
        },
      };
      return handle;
    },
    spawnDetached(spec) {
      io.detached.push(spec);
      io.state = running({ launchId: OTHER_LAUNCH, buildSha: BUILD });
      return 333;
    },
    processOps: {
      platform: 'linux',
      isAlive: pid => alive.has(pid),
      async terminateTree(pid, authorize) {
        const authorized = authorize ? await authorize() : true;
        io.signals.push({ pid, authorized });
        if (!authorized) throw new Error('authorization refused');
        alive.delete(pid);
      },
      async describeTcpListener() { return null; },
      async ancestorPids() { return []; },
      async processBirthId(pid) {
        if (!alive.has(pid)) return null;
        if (pid === process.pid) return 'owner-birth';
        return pid === 222 ? 'birth-222' : 'runner-birth';
      },
      async processLaunchId(pid) {
        if (pid !== 222) return null;
        if (io.state?.phase === 'running' || io.state?.phase === 'launching') return io.state.launchId;
        if (io.state?.phase === 'stopping') return io.state.target.launchId;
        return LAUNCH;
      },
    },
    async launcherHealth(url, token) {
      io.healthUrls.push(url); io.healthTokens.push(token);
      const current = io.state;
      return current?.phase === 'running' ? { ok: true, pid: current.pid, launch_id: current.launchId } : { ok: false };
    },
    async projectsHealth(url) { io.projectUrls.push(url); return true; },
  };
  return io;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dashboard content identity and state grammar', () => {
  it('hashes server and optional build-info bytes', () => {
    const files = new Map([['server', Buffer.from('server')], ['info', Buffer.from('info')]]);
    const read = (file: string): Uint8Array => {
      const value = files.get(file);
      if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    };
    const both = dashboardBuildIdentity('server', 'info', read);
    files.set('server', Buffer.from('changed'));
    expect(dashboardBuildIdentity('server', 'info', read)).not.toBe(both);
    files.set('server', Buffer.from('server'));
    files.set('info', Buffer.from('changed'));
    expect(dashboardBuildIdentity('server', 'info', read)).not.toBe(both);
    files.delete('info');
    expect(dashboardBuildIdentity('server', 'info', read)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps build identity stable across case-folded path spellings', () => {
    const files = new Map([['server.js', Buffer.from('server')], ['build-info.json', Buffer.from('info')]]);
    const read = (file: string): Uint8Array => {
      const bytes = files.get(path.basename(file).toLowerCase());
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return bytes;
    };
    expect(dashboardBuildIdentity('/Checkout/SERVER.JS', '/Checkout/BUILD-INFO.JSON', read))
      .toBe(dashboardBuildIdentity('/checkout/server.js', '/checkout/build-info.json', read));
  });

  it('validates build identity shape', () => {
    expect(isDashboardBuildIdentity(BUILD)).toBe(true);
    expect(isDashboardBuildIdentity(`${BUILD}:${OTHER_BUILD}`)).toBe(true);
    expect(isDashboardBuildIdentity('git-sha')).toBe(false);
  });

  it('accepts exact running state and rejects missing birth id or extra keys', () => {
    expect(parseDashboardState(running())).toEqual(running());
    const { birthId: _birthId, ...missing } = running();
    expect(parseDashboardState(missing)).toBeNull();
    expect(parseDashboardState({ ...running(), surprise: true })).toBeNull();
  });

  it.each(['reserved', 'launching', 'stopping'])('validates the %s phase exact-key grammar', phase => {
    const state: unknown = phase === 'reserved'
      ? { schema: 1, phase, launchId: LAUNCH, buildSha: BUILD, starterPid: 1, reservedAt: '2026-09-10T12:00:00.000Z' }
      : phase === 'launching'
        ? { schema: 1, phase, launchId: LAUNCH, buildSha: BUILD, runnerPid: 1, runnerBirthId: 'birth', serverPid: null }
        : { schema: 1, phase, operationId: OTHER_LAUNCH, ownerPid: 1, ownerBirthId: 'birth', target: running() };
    expect(parseDashboardState(state)?.phase).toBe(phase);
    expect(parseDashboardState({ ...Object(state), extra: 1 })).toBeNull();
  });
});

describe('dashboard health URL ownership', () => {
  it.each([
    ['127.0.0.1', 'http://127.0.0.1:7123'], ['localhost', 'http://127.0.0.1:7123'],
    ['0.0.0.0', 'http://127.0.0.1:7123'], ['::', 'http://[::1]:7123'], ['[::]', 'http://[::1]:7123'],
    ['::1', 'http://[::1]:7123'], ['[::1]', 'http://[::1]:7123'],
  ])('derives %s as %s', (bind, expected) => expect(resolveHealthUrl(bind, 7123)).toBe(expected));

  it('preserves explicit credential-free HTTP and HTTPS URLs', () => {
    expect(validateHealthUrl('http://192.0.2.10:6601/')).toBe('http://192.0.2.10:6601');
    expect(validateHealthUrl('https://example.test/')).toBe('https://example.test');
  });

  it.each(['ftp://example.test', 'http://user:pass@example.test', 'http://example.test:0', 'http://example.test:65536', 'http://example.test/ bad'])
  ('rejects invalid URLs without reflecting the input', value => {
    expect(() => validateHealthUrl(value)).toThrow('MAI_BRAIN_WEB_URL must be an http(s) URL without credentials');
    try { validateHealthUrl(value); } catch (error) { expect(String(error)).not.toContain(value); }
  });

  it('requires an explicit URL for a non-loopback bind', () => {
    expect(() => resolveHealthUrl('192.0.2.10', 6601)).toThrow('set MAI_BRAIN_WEB_URL');
    expect(resolveHealthUrl('192.0.2.10', 6601, 'http://192.0.2.10:6601')).toBe('http://192.0.2.10:6601');
  });
});

describe('dashboard environment boundary', () => {
  it('pins the combined allowlist to the source-derived MAI keys plus controller and provider keys', () => {
    const sourceFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !['__tests__', 'scripts'].includes(entry.name)) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) sourceFiles.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    const derived = new Set<string>();
    for (const file of sourceFiles) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/process\.env\.(MAI_[A-Z_]+)/gu)) derived.add(match[1]);
    }
    for(const key of Object.values(JEV_ENV_KEYS))derived.add(key);
    const runtimeTests=fs.readFileSync(path.join(ROOT,'src/__tests__/providers-runtime.test.ts'),'utf8');
    expect(runtimeTests).toContain('JEV_ENV_KEYS.enabled');
    expect(runtimeTests).toContain('JEV_ENV_KEYS.model');
    derived.delete('MAI_BRAIN_WEB_LAUNCH_ID');
    expect([...DASHBOARD_SERVER_ENV_KEYS].sort()).toEqual([...derived].sort());
    expect(DASHBOARD_PRIVATE_ENV_KEYS).toEqual([...new Set([...derived, ...DASHBOARD_CONTROLLER_ENV_KEYS, ...DASHBOARD_PROVIDER_ENV_KEYS])].sort());
  });

  it('uses only private-file keys and platform base under --env-file', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.env.MAI_CANARY = 'leak';
    io.env.MAI_BRAIN_WEB_URL = 'http://ambient.test:9999';
    io.privateFile = 'MAI_BRAIN_WEB_TOKEN=secret\nMAI_BRAIN_WEB_URL=http://192.0.2.10:6601\nMAI_BRAIN_WEB_BIND=192.0.2.10\n';
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const result = dashboardRun({ envFile: '/private/dashboard.env', launchId: LAUNCH }, io);
    await new Promise(resolve => setImmediate(resolve));
    expect(io.specs[0].env.MAI_BRAIN_WEB_TOKEN).toBe('secret');
    expect(io.specs[0].env.MAI_CANARY).toBeUndefined();
    expect(io.specs[0].argv).toContain('--mai-private-environment');
    expect(io.specs[0].argv.join(' ')).not.toContain('secret');
    expect(io.stateHistory.map(value => JSON.stringify(value)).join('\n')).not.toContain('secret');
    expect(io.healthUrls).toEqual(['http://192.0.2.10:6601']);
    expect(io.projectUrls).toEqual(['http://192.0.2.10:6601']);
    expect(io.healthTokens).toEqual(['secret']);
    finish({ code: 0, signal: null });
    expect(await result).toBe(0);
  });

  it.each(['synthetic-typesafe-secret',''])('forwards private Jev overrides without argv or state leakage (%s)',async key=>{
    const io=fakeIO({schema:1,phase:'reserved',launchId:LAUNCH,buildSha:BUILD,starterPid:process.pid,reservedAt:'2026-09-10T12:00:00.000Z'});
    io.privateFile=`TYPESAFE_API_KEY=${key}\nMAI_JEV_ENABLED=\nMAI_JEV_MODEL=\n`;
    io.env.MAI_CANARY='unrelated';
    expect(await dashboardRun({envFile:'/private/dashboard.env',launchId:LAUNCH},io)).toBe(0);
    expect(io.specs[0].env.TYPESAFE_API_KEY).toBe(key);expect(io.specs[0].env.MAI_JEV_ENABLED).toBe('');expect(io.specs[0].env.MAI_JEV_MODEL).toBe('');
    expect(io.specs[0].env.MAI_CANARY).toBeUndefined();
    expect(JSON.stringify([io.specs[0].argv,io.stateHistory])).not.toContain('synthetic-typesafe-secret');
  });

  it('passes the explicit interactive environment through unchanged without --env-file', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD,
      starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.env.MAI_CANARY = 'interactive-value';
    io.childExit = { code: 0, signal: null };
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(0);
    expect(io.specs[0].env.MAI_CANARY).toBe('interactive-value');
  });

  it('keeps the private token out of the actual child log', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard token log '));
    try {
      const adapter = defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root });
      const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD,
        starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
      io.privateFile = 'MAI_BRAIN_WEB_TOKEN=actual-log-secret\n';
      io.openLog = adapter.openLog;
      io.closeLog = adapter.closeLog;
      const actual = defaultProcessOps();
      let childPid = 0;
      io.processOps = {
        ...actual,
        isAlive: pid => pid === process.pid || actual.isAlive(pid),
        processBirthId: pid => pid === process.pid ? Promise.resolve('owner-birth')
          : Promise.resolve(pid === childPid && actual.isAlive(pid) ? 'actual-child-birth' : null),
      };
      io.spawnAttached = spec => {
        const handle = spawnPlatformAttached({
          ...spec,
          argv: [process.execPath, '-e', "console.error('safe child output');setTimeout(()=>{},100)", '--', '--launch-id', LAUNCH],
        });
        childPid = handle.pid;
        return handle;
      };
      io.processOps.processLaunchId = pid => pid === childPid ? Promise.resolve(LAUNCH) : actual.processLaunchId(pid);
      expect(await dashboardRun({ envFile: path.join(root, 'private.env'), launchId: LAUNCH }, io)).toBe(0);
      const log = fs.readFileSync(path.join(root, 'dashboard.log'), 'utf8');
      expect(log).toContain('safe child output');
      expect(log).not.toContain('actual-log-secret');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses unknown and duplicate private-file keys before spawn', async () => {
    for (const body of ['MAI_CANARY=leak\n', 'MAI_DB_URL=one\nMAI_DB_URL=two\n']) {
      const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
      io.privateFile = body;
      await expect(dashboardRun({ envFile: '/private/dashboard.env', launchId: LAUNCH }, io)).rejects.toThrow('private dashboard environment');
      expect(io.specs).toHaveLength(0);
    }
  });

  it('selects private CLI/server routes by filesystem identity and leaves ordinary routes unchanged', () => {
    const moduleDir = path.join(ROOT, 'build');
    expect(shouldLoadCheckoutEnv([process.execPath, path.join(moduleDir, 'entry.js'), 'projects'], moduleDir)).toBe(true);
    expect(shouldLoadCheckoutEnv([process.execPath, path.join(moduleDir, 'entry.js'), 'dashboard', 'run', '--env-file'], moduleDir)).toBe(false);
    expect(shouldLoadCheckoutEnv([process.execPath, path.join(moduleDir, 'web-server.js'), '--launch-id', LAUNCH, '--mai-private-environment'], moduleDir)).toBe(false);
    expect(shouldLoadCheckoutEnv([process.execPath, path.join(moduleDir, 'web-server.js'), '--launch-id', LAUNCH], moduleDir)).toBe(true);
  });

  it('keeps checkout dotenv out of both private fresh-child routes, including a symlinked CLI entry', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-dashboard-env-'));
    try {
      const build = path.join(fixture, 'build');
      const bin = path.join(fixture, 'bin');
      fs.mkdirSync(build); fs.mkdirSync(bin);
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(fixture, 'node_modules'));
      const source = fs.readFileSync(path.join(ROOT, 'src', 'env.ts'), 'utf8');
      fs.copyFileSync(path.join(ROOT, 'build', 'automation-command.js'), path.join(build, 'automation-command.js'));
      fs.writeFileSync(path.join(build, 'env.js'), ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText);
      fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n');
      fs.writeFileSync(path.join(fixture, '.env'), 'MAI_BRAIN_WEB_TOKEN=checkout-token\nMAI_CANARY=checkout-canary\nOPENAI_API_KEY=checkout-provider\n');
      const privateFile = path.join(fixture, 'private.env');
      fs.writeFileSync(privateFile, '');
      const entry = `import './env.js'; console.log(JSON.stringify({token:process.env.MAI_BRAIN_WEB_TOKEN,canary:process.env.MAI_CANARY,provider:process.env.OPENAI_API_KEY}));\n`;
      for (const name of ['entry.js', 'cli.js', 'web-server.js']) fs.writeFileSync(path.join(build, name), entry);
      fs.symlinkSync(path.join(build, 'entry.js'), path.join(bin, 'mai.js'));
      const invoke = (script: string, args: string[]) => {
        const result = spawnSync(process.execPath, [script, ...args], {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: 'selected-provider' },
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout.trim());
      };
      expect(invoke(path.join(build, 'entry.js'), ['projects'])).toEqual({
        token: 'checkout-token', canary: 'checkout-canary', provider: 'selected-provider',
      });
      expect(invoke(path.join(build, 'entry.js'), ['dashboard', 'run', '--env-file'])).toEqual({ provider: 'selected-provider' });
      expect(invoke(path.join(bin, 'mai.js'), ['dashboard', 'run', '--env-file', privateFile])).toEqual({ provider: 'selected-provider' });
      expect(invoke(path.join(build, 'web-server.js'), ['--launch-id', LAUNCH, '--mai-private-environment'])).toEqual({ provider: 'selected-provider' });
      expect(invoke(path.join(build, 'web-server.js'), ['--launch-id', LAUNCH])).toEqual({
        token: 'checkout-token', canary: 'checkout-canary', provider: 'selected-provider',
      });
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  it('loads the actual copied server/env boundary with network and DB dependencies mocked', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard real server boundary '));
    try {
      const build = path.join(fixture, 'build');
      fs.mkdirSync(build);
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(fixture, 'node_modules'));
      fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n');
      fs.copyFileSync(path.join(ROOT, 'build', 'env.js'), path.join(build, 'env.js'));
      fs.copyFileSync(path.join(ROOT, 'build', 'automation-command.js'), path.join(build, 'automation-command.js'));
      const serverSource = fs.readFileSync(path.join(ROOT, 'build', 'web-server.js'), 'utf8');
      fs.writeFileSync(path.join(build, 'web-server.js'), serverSource);
      const parsed = ts.createSourceFile('web-server.js', serverSource, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('.') || specifier === './env.js') continue;
        const target = path.resolve(build, specifier);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const names = statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
          ? statement.importClause.namedBindings.elements.map(element => element.name.text) : [];
        fs.writeFileSync(target, names.map(name => name === 'makeShutdown'
          ? `export function ${name}(){return ()=>Promise.resolve()}\n`
          : `export function ${name}(){}\n`).join(''));
      }
      const hook = path.join(fixture, 'mock-http.mjs');
      fs.writeFileSync(hook, `import { registerHooks } from 'node:module';
registerHooks({load(url, context, nextLoad) {
  if (url === 'node:http') return {format:'module',shortCircuit:true,source:\`const server={listen(...args){const cb=args.at(-1);if(typeof cb==='function')cb()},close(cb){if(cb)cb()},on(){return server}};export default {createServer(){return server}};\`};
  return nextLoad(url, context);
}});\n`);
      fs.writeFileSync(path.join(fixture, '.env'), 'MAI_BRAIN_WEB_TOKEN=checkout-token\nOPENAI_API_KEY=checkout-provider\n');
      // --import takes a specifier, not a path: on Windows an absolute path
      // parses as a URL whose drive letter is an unsupported scheme.
      const invoke = (extra: string[]) => spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, path.join(build, 'web-server.js'), ...extra], {
        cwd: fixture,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, MAI_BRAIN_WEB_BIND: '192.0.2.10', MAI_BRAIN_WEB_LAUNCH_ID: LAUNCH },
        encoding: 'utf8', timeout: 5_000,
      });
      const privateResult = invoke(['--launch-id', LAUNCH, '--mai-private-environment']);
      expect(privateResult.status).toBe(1);
      expect(privateResult.stderr).toContain('MAI_BRAIN_WEB_TOKEN is empty');
      expect(privateResult.stderr).not.toContain('checkout-token');
      const interactiveResult = invoke(['--launch-id', LAUNCH]);
      expect(interactiveResult.status, interactiveResult.stderr).toBe(0);
      expect(interactiveResult.stdout).toContain('token required');
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  it('keeps the actual copied CLI private across dotenv mutation while ordinary CLI remains interactive', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard real cli boundary '));
    try {
      const build = path.join(fixture, 'build');
      fs.cpSync(path.join(ROOT, 'build'), build, { recursive: true });
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(fixture, 'node_modules'));
      fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n');
      const privateFile = path.join(fixture, 'private.env');
      fs.writeFileSync(privateFile, 'MAI_BRAIN_WEB_TOKEN=private-token\n', { mode: 0o600 });
      const hook = path.join(fixture, 'mock-dashboard.mjs');
      fs.writeFileSync(hook, `import { registerHooks } from 'node:module';
const source = \`const snapshot=()=>console.log('DASHBOARD_ENV '+JSON.stringify({token:process.env.MAI_BRAIN_WEB_TOKEN,canary:process.env.MAI_CANARY,provider:process.env.OPENAI_API_KEY}));
export async function dashboardRun(){snapshot();return 0}
export async function dashboardStart(){snapshot();return 'started'}
export async function dashboardStop(){snapshot();return 'stopped'}
export async function dashboardStatus(){snapshot();return {ok:true,text:'Health: OK'}}\`;
registerHooks({load(url, context, nextLoad) {
  if (url.endsWith('/scripts/dashboard.js')) return {format:'module',shortCircuit:true,source};
  return nextLoad(url, context);
}});\n`);
      // --import takes a specifier, not a path: on Windows an absolute path
      // parses as a URL whose drive letter is an unsupported scheme.
      const invoke = (args: string[]) => spawnSync(process.execPath,
        ['--import', pathToFileURL(hook).href, path.join(build, 'entry.js'), ...args], {
          cwd: fixture,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: 'selected-provider' },
          encoding: 'utf8', timeout: 5_000,
        });
      const snapshot = (result: ReturnType<typeof invoke>) => {
        expect(result.status, result.stderr).toBe(0);
        const line = result.stdout.split('\n').find(value => value.startsWith('DASHBOARD_ENV '));
        if (!line) throw new Error(`dashboard environment snapshot missing: ${result.stdout}`);
        return JSON.parse(line.slice('DASHBOARD_ENV '.length));
      };
      fs.writeFileSync(path.join(fixture, '.env'),
        'MAI_BRAIN_WEB_TOKEN=checkout-token-one\nMAI_CANARY=checkout-canary-one\nOPENAI_API_KEY=checkout-provider-one\n');
      expect(snapshot(invoke(['dashboard', 'run', '--env-file', privateFile]))).toEqual({ provider: 'selected-provider' });
      fs.writeFileSync(path.join(fixture, '.env'),
        'MAI_BRAIN_WEB_TOKEN=checkout-token-two\nMAI_CANARY=checkout-canary-two\nOPENAI_API_KEY=checkout-provider-two\n');
      expect(snapshot(invoke(['dashboard', 'run', '--env-file', privateFile]))).toEqual({ provider: 'selected-provider' });
      expect(snapshot(invoke(['dashboard', 'status']))).toEqual({
        token: 'checkout-token-two', canary: 'checkout-canary-two', provider: 'selected-provider',
      });
      const observer = path.join(fixture, 'observe-environment.mjs');
      fs.writeFileSync(observer, `process.on('exit',()=>console.log('PROCESS_ENV '+JSON.stringify({token:process.env.MAI_BRAIN_WEB_TOKEN,canary:process.env.MAI_CANARY,provider:process.env.OPENAI_API_KEY})));\n`);
      const control = (script: string, args: string[], inherited: NodeJS.ProcessEnv = {}) => {
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(observer).href, script, ...args], {
          cwd: fixture,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: 'selected-provider',
            MAI_PROJECT_SLUG: 'test-project', ...inherited },
          encoding: 'utf8', input: '', timeout: 5_000,
        });
        const line = result.stdout.split('\n').find(value => value.startsWith('PROCESS_ENV '));
        if (!line) throw new Error(`control environment snapshot missing: ${result.stderr}`);
        return JSON.parse(line.slice('PROCESS_ENV '.length));
      };
      const ordinaryEnvironment = {
        token: 'checkout-token-two', canary: 'checkout-canary-two', provider: 'selected-provider',
      };
      expect(control(path.join(build, 'index.js'), [])).toEqual(ordinaryEnvironment);
      expect(control(path.join(build, 'scripts', 'hook-runner.js'), ['codex-notify'], {
        MAI_BRAIN_WEB_TOKEN: 'inherited-hook-token', MAI_CANARY: 'inherited-hook-canary',
      })).toEqual({ token: 'inherited-hook-token', canary: 'inherited-hook-canary', provider: 'selected-provider' });
      const malformed = invoke(['dashboard', 'run', '--env-file']);
      expect(malformed.status).toBe(2);
      expect(malformed.stdout).toContain('usage: mai dashboard run');
      expect(malformed.stdout).not.toContain('checkout-token-two');
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  it('refuses an actual default-adapter managed-path alias before state access', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard paths '));
    try {
      const state = path.join(root, 'dashboard-state.json');
      const log = path.join(root, 'dashboard.log');
      fs.writeFileSync(state, '{}', { mode: 0o600 });
      fs.linkSync(state, log);
      expect(() => defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root }).preparePaths()).toThrow('distinct');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  const managedNames = ['dashboard-state.json', 'dashboard-lock.sqlite', 'dashboard-lock.sqlite-journal',
    'dashboard-lock.sqlite-wal', 'dashboard-lock.sqlite-shm', 'dashboard.log'];
  const managedPairs = managedNames.flatMap((first, index) => managedNames.slice(index + 1).map(second => ({ first, second })));
  it.each(managedPairs)('rejects actual default-adapter alias $first ↔ $second before any verb state read', ({ first, second }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard matrix '));
    try {
      fs.writeFileSync(path.join(root, first), 'sentinel', { mode: 0o600 });
      fs.linkSync(path.join(root, first), path.join(root, second));
      expect(() => defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root }).preparePaths()).toThrow('distinct');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(managedNames)('rejects private environment collision with $s', managed => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard env matrix '));
    try {
      const managedPath = path.join(root, managed);
      const envFile = path.join(root, 'private.env');
      fs.writeFileSync(managedPath, 'sentinel', { mode: 0o600 });
      fs.linkSync(managedPath, envFile);
      expect(() => defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root }).preparePaths(envFile)).toThrow('distinct');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(managedPairs)('rejects default-adapter pair $first ↔ $second through all four public verbs', async ({ first, second }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard public matrix '));
    try {
      fs.writeFileSync(path.join(root, first), 'sentinel', { mode: 0o600 });
      fs.linkSync(path.join(root, first), path.join(root, second));
      const env = { ...process.env, MAI_STATE_HOME: root };
      await expect(dashboardStart(defaultDashboardIO(env))).rejects.toThrow('distinct');
      await expect(dashboardRun({}, defaultDashboardIO(env))).rejects.toThrow('distinct');
      await expect(dashboardStatus(defaultDashboardIO(env))).rejects.toThrow('distinct');
      await expect(dashboardStop(defaultDashboardIO(env))).rejects.toThrow('distinct');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(managedNames)('rejects default-adapter private environment collision with $s through supervised run', async managed => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard persistence matrix '));
    try {
      const managedPath = path.join(root, managed);
      const envFile = path.join(root, 'private.env');
      fs.writeFileSync(managedPath, 'sentinel', { mode: 0o600 });
      fs.linkSync(managedPath, envFile);
      await expect(dashboardRun({ envFile }, defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root }))).rejects.toThrow('distinct');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a symlinked private environment through the actual default adapter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard private symlink '));
    try {
      const target = path.join(root, 'target.env');
      const link = path.join(root, 'private.env');
      fs.writeFileSync(target, 'MAI_DB_URL=postgres://private\n', { mode: 0o600 });
      fs.symlinkSync(target, link);
      expect(() => defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root }).readPrivateFile(link)).toThrow();
      expect(fs.readFileSync(target, 'utf8')).toBe('MAI_DB_URL=postgres://private\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('refuses a foreign-owned private environment through the actual adapter boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard private owner '));
    try {
      const envFile = path.join(root, 'private.env');
      fs.writeFileSync(envFile, 'MAI_DB_URL=postgres://private\n', { mode: 0o600 });
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error('uid unavailable');
      const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
      Object.defineProperty(process, 'getuid', { configurable: true, value: () => uid + 1 });
      try {
        expect(() => defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root }).readPrivateFile(envFile)).toThrow('owned by the current user');
      } finally {
        if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
        else Reflect.deleteProperty(process, 'getuid');
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a case-equivalent environment alias through supervised run before state access', async () => {
    // Only Darwin and Windows fold case: on Linux DASHBOARD.LOG is a distinct absent file.
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard case alias '));
    try {
      const io = defaultDashboardIO({ ...process.env, MAI_STATE_HOME: root });
      await expect(dashboardRun({ envFile: path.join(root, 'DASHBOARD.LOG') }, io)).rejects.toThrow('distinct');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['symlink', 'directory', 'fifo'])('hostile %s log target is refused through both start and run before spawn', async kind => {
    if (kind === 'fifo' && process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard hostile log '));
    try {
      const log = path.join(root, 'dashboard.log');
      const sentinel = path.join(root, 'sentinel');
      fs.writeFileSync(sentinel, 'unchanged', { mode: 0o600 });
      if (kind === 'symlink') fs.symlinkSync(sentinel, log);
      else if (kind === 'directory') fs.mkdirSync(log);
      else {
        const made = spawnSync('mkfifo', [log], { encoding: 'utf8' });
        expect(made.status, made.stderr).toBe(0);
      }
      const env = { ...process.env, MAI_STATE_HOME: root };
      await expect(dashboardStart(defaultDashboardIO(env))).rejects.toThrow('regular non-symlink');
      await expect(dashboardRun({}, defaultDashboardIO(env))).rejects.toThrow('regular non-symlink');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('dashboard lifecycle controller', () => {
  it('actual spawned server holds no lock descriptor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard lock fd '));
    const lock = path.join(root, 'dashboard-lock.sqlite');
    const log = path.join(root, 'child.log');
    const logFd = fs.openSync(log, 'a', 0o600);
    const children: ChildHandle[] = [];
    try {
      await withPlatformStateLock(lock, 1_000, async () => {
        children.push(spawnPlatformAttached({
          argv: [process.execPath, '-e', "const fs=require('fs');const d='/dev/fd';console.log(fs.existsSync(d)?fs.readdirSync(d).map(x=>{try{return fs.readlinkSync(d+'/'+x)}catch{return ''}}).join('\\n'):'fd-inspection-unavailable')"],
          env: { PATH: process.env.PATH }, cwd: root, logFd,
        }));
      });
      fs.closeSync(logFd);
      const child = children[0];
      if (!child) throw new Error('child was not spawned');
      expect((await child.wait()).code).toBe(0);
      expect(fs.readFileSync(log, 'utf8')).not.toContain(lock);
    } finally {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('clean start reserves then backgrounds dashboard run with one launch id', async () => {
    const io = fakeIO();
    const text = await dashboardStart(io);
    expect(text).toContain('mai-brain-web started, pid=222');
    expect(io.detached).toHaveLength(1);
    expect(io.detached[0].argv.slice(-4)).toEqual(['dashboard', 'run', '--launch-id', OTHER_LAUNCH]);
    expect(io.prepared).toEqual([undefined]);
    expect(io.closedLogs).toEqual([9]);
  });

  it.each(['log', 'spawn'])('failed detached %s cleanup removes only its reservation', async failure => {
    const io = fakeIO();
    if (failure === 'log') io.openLog = () => { throw new Error('log failed'); };
    else io.spawnDetached = () => { throw new Error('spawn failed'); };
    await expect(dashboardStart(io)).rejects.toThrow(`${failure} failed`);
    expect(io.state).toBeNull();
    expect(io.detached).toHaveLength(0);
    expect(io.closedLogs).toEqual(failure === 'spawn' ? [9] : []);
  });

  it('an unexpired reservation is idempotent and spawns nothing', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    expect(await dashboardStart(io)).toContain('start already in progress');
    expect(io.detached).toHaveLength(0);
  });

  it('current healthy start is idempotent', async () => {
    const io = fakeIO(running());
    expect(await dashboardStart(io)).toContain('already running');
    expect(io.detached).toHaveLength(0);
  });

  it.each([
    {
      name: 'launching', message: 'incomplete launch; ownership cannot be proved',
      state: { schema: 1, phase: 'launching', launchId: LAUNCH, buildSha: BUILD, runnerPid: 111,
        runnerBirthId: 'runner-birth', serverPid: 222 } satisfies DashboardState,
    },
    {
      name: 'stopping', message: 'stop in progress',
      state: { schema: 1, phase: 'stopping', operationId: OTHER_LAUNCH, ownerPid: 111,
        ownerBirthId: 'runner-birth', target: running() } satisfies DashboardState,
    },
  ])('start rejects unresolved $name state without replacing it', async ({ state, message }) => {
    const io = fakeIO(state);
    await expect(dashboardStart(io)).rejects.toThrow(message);
    expect(io.state).toEqual(state);
    expect(io.detached).toHaveLength(0);
  });

  it('run + status/idempotent start/stop share one child', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const runResult = dashboardRun({ launchId: LAUNCH }, io);
    await new Promise(resolve => setImmediate(resolve));
    expect(await dashboardStatus(io)).toEqual({ ok: true, text: 'Health: OK' });
    expect(await dashboardStart(io)).toContain('already running');
    expect(await dashboardStop(io)).toBe('mai-brain-web stopped, pid=222');
    finish({ code: null, signal: 'SIGTERM' });
    expect(await runResult).toBe(143);
    expect(io.specs).toHaveLength(1);
    expect(io.detached).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('SIGSTOPped child is not misclassified as dead', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let serverPid = 0;
    let actualHandle: ChildHandle | null = null;
    io.openLog = () => fs.openSync('/dev/null', 'a');
    io.closeLog = fd => fs.closeSync(fd);
    io.spawnAttached = spec => {
      const handle = spawnPlatformAttached({ ...spec, argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] });
      actualHandle = handle;
      serverPid = handle.pid;
      return handle;
    };
    const alive = (pid: number) => {
      if (pid === process.pid || pid === 111) return true;
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    io.processOps.isAlive = alive;
    io.processOps.processBirthId = async pid => pid === process.pid ? 'owner-birth' : pid === 111 ? 'runner-birth' : pid === serverPid && alive(pid) ? 'actual-child-birth' : null;
    io.processOps.processLaunchId = async pid => pid === serverPid && alive(pid) ? LAUNCH : null;
    io.processOps.terminateTree = async (pid, authorize) => {
      if (!await authorize?.()) throw new Error('authorization refused');
      process.kill(pid, 'SIGCONT');
      process.kill(pid, 'SIGTERM');
      if (!actualHandle) throw new Error('missing attached child');
      await actualHandle.wait();
    };
    const runResult = dashboardRun({ launchId: LAUNCH }, io);
    while (io.state?.phase !== 'running') await new Promise(resolve => setImmediate(resolve));
    process.kill(serverPid, 'SIGSTOP');
    expect(await dashboardStatus(io)).toEqual({ ok: true, text: 'Health: OK' });
    expect(await dashboardStop(io)).toContain('stopped');
    expect(await runResult).toBe(143);
  });

  it('start versus foreground run interleaving produces only the reserved runner spawn', async () => {
    vi.useFakeTimers();
    const base = Date.parse('2026-09-10T12:00:00.000Z');
    const io = fakeIO();
    io.now = () => new Date(base + performance.now());
    io.spawnDetached = spec => { io.detached.push(spec); return 333; };
    const start = dashboardStart(io);
    const rejection = expect(start).rejects.toThrow('did not become healthy');
    await Promise.resolve();
    await Promise.resolve();
    expect(await dashboardRun({}, io)).toBe(3);
    await vi.advanceTimersByTimeAsync(8_500);
    await rejection;
    expect(io.detached).toHaveLength(1);
    expect(io.specs).toHaveLength(0);
  });

  it('foreground run wins against a losing start without a second server spawn', async () => {
    const io = fakeIO();
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const run = dashboardRun({}, io);
    await new Promise(resolve => setImmediate(resolve));
    expect(await dashboardStart(io)).toContain('already running');
    expect(io.specs).toHaveLength(1);
    expect(io.detached).toHaveLength(0);
    finish({ code: 0, signal: null });
    expect(await run).toBe(0);
  });

  it('run refuses a missing or foreign reservation with 3 and no spawn', async () => {
    const io = fakeIO();
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(3);
    expect(io.specs).toHaveLength(0);
  });

  it('requested-launch refusal emits the exact redacted reservation diagnostic', async () => {
    const io = fakeIO();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(3);
    expect(stderr).toHaveBeenCalledWith(`error: no reservation for launch ${LAUNCH}\n`);
  });

  it('interactive run emits exact running and reserved refusal diagnostics', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const live = fakeIO(running());
    expect(await dashboardRun({}, live)).toBe(3);
    expect(stderr).toHaveBeenLastCalledWith('error: dashboard already running under runner 111\n');
    const reserved = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD,
      starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    expect(await dashboardRun({}, reserved)).toBe(3);
    expect(stderr).toHaveBeenLastCalledWith('error: start in progress\n');
    expect(live.specs).toHaveLength(0);
    expect(reserved.specs).toHaveLength(0);
  });

  it('expired reservation is removed and a delayed old run refuses', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: 999, reservedAt: '2026-09-10T12:00:00.000Z' });
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(3);
    expect(io.state).toBeNull();
    expect(io.specs).toHaveLength(0);
  });

  it('reservation/current-build mismatch preserves the reservation and spawns nothing', async () => {
    const reservation: DashboardState = { schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: OTHER_BUILD,
      starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' };
    const io = fakeIO(reservation);
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(3);
    expect(io.state).toEqual(reservation);
    expect(io.specs).toHaveLength(0);
  });

  it('run consumes a reservation, uses an attached server, reaps, and clears only its state', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(0);
    expect(io.specs).toHaveLength(1);
    expect(io.specs[0].argv.filter(value => value === '--launch-id')).toHaveLength(1);
    expect(io.detached).toHaveLength(0);
    expect(io.state).toBeNull();
  });

  it('run performs both health checks and does not resolve while its attached child lives', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const launcher = vi.spyOn(io, 'launcherHealth');
    const projects = vi.spyOn(io, 'projectsHealth');
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(projects).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finish({ code: 23, signal: null });
    expect(await result).toBe(23);
    expect(io.closedLogs).toEqual([9]);
  });

  it('a transient readiness rejection is retried without orphaning the attached child', async () => {
    vi.useFakeTimers();
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const original = io.launcherHealth;
    const health = vi.spyOn(io, 'launcherHealth').mockRejectedValueOnce(new Error('connection refused')).mockImplementation(original);
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    finish({ code: 0, signal: null });
    expect(await result).toBe(0);
    expect(health).toHaveBeenCalled();
  });

  it('run readiness timeout terminates, reaps, and returns the child status', async () => {
    vi.useFakeTimers();
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.launcherHealth = async () => ({ ok: false });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const originalTerminate = io.processOps.terminateTree;
    io.processOps.terminateTree = async (pid, authorize) => {
      await originalTerminate(pid, authorize);
      finish({ code: null, signal: 'SIGTERM' });
    };
    const result = dashboardRun({ launchId: LAUNCH }, io);
    await vi.advanceTimersByTimeAsync(8_500);
    expect(await result).toBe(143);
    expect(io.signals).toEqual([{ pid: 222, authorized: true }]);
  });

  it('pre-readiness child exit waits for in-flight stop finalization before returning authoritative status', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.launcherHealth = async () => new Promise<unknown>(() => {});
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    let releaseFinalization: () => void = () => {};
    const finalizationBarrier = new Promise<void>(resolve => { releaseFinalization = resolve; });
    let enteredFinalization: () => void = () => {};
    const finalizationEntered = new Promise<void>(resolve => { enteredFinalization = resolve; });
    const unlocked = io.withStateLock;
    let stoppingAcquisitions = 0;
    io.withStateLock = fn => unlocked(async () => {
      if (io.state?.phase === 'stopping') {
        stoppingAcquisitions += 1;
        if (stoppingAcquisitions === 2) {
          enteredFinalization();
          await finalizationBarrier;
        }
      }
      return fn();
    });
    const before = new Set(process.listeners('SIGTERM'));
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const listener = process.listeners('SIGTERM').find(candidate => !before.has(candidate));
    if (!listener) throw new Error('signal listener was not installed');
    listener('SIGTERM');
    await finalizationEntered;
    finish({ code: 23, signal: null });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(io.state?.phase).toBe('stopping');
    releaseFinalization();
    expect(await result).toBe(23);
    expect(io.state).toBeNull();
  });

  it('run propagates the child status even when post-wait cleanup fails', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.childExit = { code: 23, signal: null };
    let locks = 0;
    io.withStateLock = async fn => {
      locks += 1;
      if (locks === 2) throw new Error('cleanup failed');
      return fn();
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(23);
    expect(stderr).toHaveBeenCalledWith('error: dashboard exit cleanup failed; child status preserved\n');
  });

  it('a child exiting before health is reaped with its exact run status', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.childExit = { code: 7, signal: null };
    io.launcherHealth = vi.fn(async () => new Promise<unknown>(() => {}));
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(7);
    expect(io.state).toBeNull();
  });

  it.each(['child assignment', 'launching.serverPid', 'readiness', 'running publication'])
  ('signal barrier at $s forwards only after the proved child is owned', async barrier => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const before = new Set(process.listeners('SIGTERM'));
    let fired = false;
    const fire = () => {
      if (fired) return;
      const listener = process.listeners('SIGTERM').find(candidate => !before.has(candidate));
      if (!listener) throw new Error('signal listener was not installed');
      fired = true;
      listener('SIGTERM');
    };
    const originalSpawn = io.spawnAttached;
    if (barrier === 'child assignment') io.spawnAttached = spec => { const handle = originalSpawn(spec); fire(); return handle; };
    const originalWrite = io.writeState;
    io.writeState = state => {
      originalWrite(state);
      if (barrier === 'launching.serverPid' && state.phase === 'launching' && state.serverPid !== null) fire();
      if (barrier === 'running publication' && state.phase === 'running') fire();
    };
    const originalHealth = io.launcherHealth;
    io.launcherHealth = async (url, token) => {
      if (barrier === 'readiness') fire();
      return originalHealth(url, token);
    };
    const result = dashboardRun({ launchId: LAUNCH }, io);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(fired).toBe(true);
    finish({ code: null, signal: 'SIGTERM' });
    expect(await result).toBe(143);
    expect(io.forwarded).toEqual(['SIGTERM']);
  });

  it('post-spawn identity failure keeps supervising until reap, then cleans only its launch', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.processOps.processLaunchId = async () => OTHER_LAUNCH;
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(io.state?.phase).toBe('launching');
    expect(settled).toBe(false);
    finish({ code: 1, signal: null });
    try {
      await result;
      throw new Error('expected preparation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const failures = error instanceof AggregateError ? error.errors.map(String).join('\n') : '';
      expect(failures).toContain('identity could not be proved');
      expect(failures).toContain('authorization refused');
    }
    expect(io.state).toBeNull();
  });

  it('attached log-close failure cannot orphan the already spawned child', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.closeLog = () => { throw new Error('close failed'); };
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish({ code: 1, signal: null });
    await expect(result).rejects.toThrow('close failed');
    expect(io.state).toBeNull();
  });

  it.each(['log open', 'launching write finalizer'])('%s failure before a child handle removes only its exact launching state', async failure => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD,
      starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    if (failure === 'log open') io.openLog = () => { throw new Error('log open failed'); };
    else {
      const write = io.writeState;
      io.writeState = state => {
        write(state);
        if (state.phase === 'launching' && state.serverPid === null) throw new Error('write finalizer failed');
      };
    }
    const listenerCounts = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal));
    await expect(dashboardRun({ launchId: LAUNCH }, io)).rejects.toThrow('failed');
    expect(io.specs).toHaveLength(0);
    expect(io.state).toBeNull();
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal))).toEqual(listenerCounts);
  });

  it('pre-handle cleanup preserves a concurrently replaced state', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD,
      starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    const replacement = running({ launchId: OTHER_LAUNCH });
    io.openLog = () => {
      io.state = replacement;
      throw new Error('log open failed');
    };
    await expect(dashboardRun({ launchId: LAUNCH }, io)).rejects.toThrow('log open failed');
    expect(io.specs).toHaveLength(0);
    expect(io.state).toEqual(replacement);
  });

  it.each([2, 3])('publication failure at write %s supervises until reap and preserves no dead owned state', async failedWrite => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    const normalWrite = io.writeState;
    let writes = 0;
    io.writeState = state => {
      writes += 1;
      if (writes === failedWrite) throw new Error('publication failed');
      normalWrite(state);
    };
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish({ code: 1, signal: null });
    await expect(result).rejects.toThrow('publication failed');
    expect(io.state).toBeNull();
  });

  it('post-launch lock-release failure keeps supervising the child before surfacing', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let locks = 0;
    io.withStateLock = async fn => {
      locks += 1;
      const result = await fn();
      if (locks === 1) throw new LockReleaseError('release failed');
      return result;
    };
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish({ code: 1, signal: null });
    await expect(result).rejects.toThrow('release failed');
    expect(io.state).toBeNull();
  });

  it.each([0, 23, 127])('propagates natural child status %s', async code => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.childExit = { code, signal: null };
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(code);
  });

  it.each([
    { signal: 'SIGQUIT', code: 131 },
    { signal: 'SIGABRT', code: 134 },
  ] satisfies Array<{ signal: NodeJS.Signals; code: number }>)
  ('propagates natural $signal reap as $code', async ({ signal, code }) => {
    // The reap is 128 + the host's signal number: 134 on POSIX, 150 on Windows (SIGABRT = 22).
    const expected = 128 + os.constants.signals[signal];
    if (process.platform !== 'win32') expect(expected).toBe(code);
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.childExit = { code: null, signal };
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(expected);
  });

  it('preserves owned running state after an unclean SIGKILL reap', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    io.childExit = { code: null, signal: 'SIGKILL' };
    expect(await dashboardRun({ launchId: LAUNCH }, io)).toBe(137);
    expect(io.state?.phase).toBe('running');
  });

  it('run cleanup never erases replacement state', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const result = dashboardRun({ launchId: LAUNCH }, io);
    await new Promise(resolve => setImmediate(resolve));
    const replacement = running({ launchId: OTHER_LAUNCH });
    io.state = replacement;
    finish({ code: 0, signal: null });
    expect(await result).toBe(0);
    expect(io.state).toEqual(replacement);
  });

  const signalCases = [
    { signal: 'SIGINT', code: 130 }, { signal: 'SIGTERM', code: 143 }, { signal: 'SIGHUP', code: 129 },
  ] satisfies Array<{ signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'; code: number }>;
  it.each(signalCases)('run forwards $signal once, authorizes it, reaps, and returns $code', async ({ signal, code }) => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const before = new Set(process.listeners(signal));
    const result = dashboardRun({ launchId: LAUNCH }, io);
    await new Promise(resolve => setImmediate(resolve));
    const listener = process.listeners(signal).find(candidate => !before.has(candidate));
    if (!listener) throw new Error('signal listener was not installed');
    vi.useFakeTimers();
    listener(signal);
    await vi.advanceTimersByTimeAsync(3_100);
    finish({ code: null, signal });
    expect(await result).toBe(code);
    expect(io.forwarded).toEqual([signal]);
    expect(io.state).toBeNull();
  });

  it('failed supervised delivery reports safely and a later signal can retry', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const before = new Set(process.listeners('SIGTERM'));
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = dashboardRun({ launchId: LAUNCH }, io);
    await new Promise(resolve => setImmediate(resolve));
    const listener = process.listeners('SIGTERM').find(candidate => !before.has(candidate));
    if (!listener) throw new Error('signal listener was not installed');
    io.childSignal = { kind: 'failed', error: new Error('secret delivery detail') };
    listener('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith('error: dashboard shutdown failed; state preserved\n');
    expect(String(error.mock.calls)).not.toContain('secret delivery detail');
    io.childSignal = { kind: 'signalled' };
    vi.useFakeTimers();
    listener('SIGTERM');
    await vi.advanceTimersByTimeAsync(3_100);
    finish({ code: null, signal: 'SIGTERM' });
    expect(await result).toBe(143);
    expect(io.forwarded).toEqual(['SIGTERM', 'SIGTERM']);
  });

  it('unavailable first shutdown proof sends no signal and later stable proof stops the same child', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD,
      starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    io.childWait = new Promise(resolve => { finish = resolve; });
    const before = new Set(process.listeners('SIGTERM'));
    const result = dashboardRun({ launchId: LAUNCH }, io);
    await new Promise(resolve => setImmediate(resolve));
    const listener = process.listeners('SIGTERM').find(candidate => !before.has(candidate));
    if (!listener) throw new Error('signal listener was not installed');
    const birth = io.processOps.processBirthId;
    let unavailable = true;
    io.processOps.processBirthId = async pid => unavailable && pid === 222 ? null : birth(pid);
    listener('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    expect(io.forwarded).toHaveLength(0);
    expect(io.state?.phase).toBe('running');
    unavailable = false;
    listener('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    finish({ code: null, signal: 'SIGTERM' });
    expect(await result).toBe(143);
    expect(io.forwarded).toEqual(['SIGTERM']);
  });

  it('accepted but ineffective supervised escalation keeps waiting for reap', async () => {
    const io = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD,
      starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { finish = resolve; });
    let firstDelivered = () => {};
    const delivered = new Promise<void>(resolve => { firstDelivered = resolve; });
    io.spawnAttached = spec => {
      io.specs.push(spec);
      return {
        pid: 222,
        async signal(signal, authorize) {
          io.forwarded.push(signal);
          const authorized = await authorize();
          if (signal === 'SIGTERM') firstDelivered();
          return authorized ? { kind: 'signalled' } : { kind: 'failed', error: new Error('authorization refused') };
        },
        wait: () => exit,
      };
    };
    io.processOps.isAlive = pid => [process.pid, 111, 222].includes(pid);
    const before = new Set(process.listeners('SIGTERM'));
    let settled = false;
    const result = dashboardRun({ launchId: LAUNCH }, io).finally(() => { settled = true; });
    while (io.state?.phase !== 'running') {
      await new Promise(resolve => setImmediate(resolve));
    }
    const listener = process.listeners('SIGTERM').find(candidate => !before.has(candidate));
    if (!listener) throw new Error('signal listener was not installed');
    listener('SIGTERM');
    await delivered;
    expect(io.forwarded).toEqual(['SIGTERM']);
    await new Promise(resolve => setTimeout(resolve, 3_100));
    expect(io.forwarded).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settled).toBe(false);
    finish({ code: null, signal: 'SIGKILL' });
    expect(await result).toBe(137);
  });

  it('status requires identity, both health endpoints, and current build', async () => {
    const io = fakeIO(running());
    expect(await dashboardStatus(io)).toEqual({ ok: true, text: 'Health: OK' });
    io.projectsHealth = async () => false;
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: UNHEALTHY' });
  });

  it('uses one explicit non-loopback URL across start, run, status, and stop', async () => {
    const url = 'http://192.0.2.10:6601';
    const startIO = fakeIO(running({ url }));
    startIO.env.MAI_BRAIN_WEB_BIND = '192.0.2.10'; startIO.env.MAI_BRAIN_WEB_URL = url;
    expect(await dashboardStart(startIO)).toContain('already running');
    expect(startIO.healthUrls).toEqual([url]); expect(startIO.projectUrls).toEqual([url]);

    const runIO = fakeIO({ schema: 1, phase: 'reserved', launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' });
    runIO.env.MAI_BRAIN_WEB_BIND = '192.0.2.10'; runIO.env.MAI_BRAIN_WEB_URL = url;
    let finish = (_value: { code: number | null; signal: NodeJS.Signals | null }) => {};
    runIO.childWait = new Promise(resolve => { finish = resolve; });
    const runResult = dashboardRun({ launchId: LAUNCH }, runIO);
    await new Promise(resolve => setImmediate(resolve));
    expect(runIO.healthUrls).toEqual([url]); expect(runIO.projectUrls).toEqual([url]);
    finish({ code: 0, signal: null });
    expect(await runResult).toBe(0);

    const statusIO = fakeIO(running({ url }));
    expect(await dashboardStatus(statusIO)).toEqual({ ok: true, text: 'Health: OK' });
    expect(statusIO.healthUrls).toEqual([url]); expect(statusIO.projectUrls).toEqual([url]);

    const stopIO = fakeIO(running({ url }));
    expect(await dashboardStop(stopIO)).toContain('stopped');
    expect(stopIO.signals).toEqual([{ pid: 222, authorized: true }]);
  });

  it('does not attribute a healthy port listener to a different recorded PID', async () => {
    const io = fakeIO(running());
    io.processOps.describeTcpListener = async () => 'pid=999';
    io.launcherHealth = async () => ({ ok: true, pid: 999, launch_id: LAUNCH });
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: UNHEALTHY' });
    expect(io.state).toEqual(running());
    expect(io.signals).toHaveLength(0);
  });

  it('refuses an untracked healthy listener instead of false-green reporting start', async () => {
    vi.useFakeTimers();
    const base = Date.parse('2026-09-10T12:00:00.000Z');
    const io = fakeIO();
    io.now = () => new Date(base + performance.now());
    io.spawnDetached = spec => { io.detached.push(spec); return 333; };
    io.launcherHealth = async () => ({ ok: true, pid: 999, launch_id: OTHER_LAUNCH });
    io.projectsHealth = async () => true;
    const result = dashboardStart(io);
    await vi.advanceTimersByTimeAsync(8_500);
    await expect(result).rejects.toThrow('did not become healthy');
    expect(io.detached).toHaveLength(1);
    expect(io.signals).toHaveLength(0);
    expect(io.state).toBeNull();
  });

  it('detached child exit before health never produces start success', async () => {
    vi.useFakeTimers();
    const base = Date.parse('2026-09-10T12:00:00.000Z');
    const io = fakeIO();
    io.now = () => new Date(base + performance.now());
    io.spawnDetached = spec => { io.detached.push(spec); io.state = null; return 333; };
    const result = dashboardStart(io);
    const rejection = expect(result).rejects.toThrow('dashboard launch state was replaced; state preserved');
    await vi.advanceTimersByTimeAsync(8_500);
    await rejection;
    expect(io.detached).toHaveLength(1);
    expect(io.signals).toHaveLength(0);
    expect(io.state).toBeNull();
  });

  it.each(['launcher-pid', 'launcher-launch', 'projects'])('status refuses unhealthy %s corroboration without state mutation', async defect => {
    const io = fakeIO(running());
    if (defect === 'projects') io.projectsHealth = async () => false;
    else io.launcherHealth = async () => ({ ok: true, pid: defect === 'launcher-pid' ? 999 : 222,
      launch_id: defect === 'launcher-launch' ? OTHER_LAUNCH : LAUNCH });
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: UNHEALTHY' });
    expect(io.state).toEqual(running());
  });

  it.each(['reserved', 'launching', 'stopping'])('status reports the non-running %s phase without claiming health', async phase => {
    let state: DashboardState;
    if (phase === 'reserved') state = { schema: 1, phase, launchId: LAUNCH, buildSha: BUILD, starterPid: process.pid, reservedAt: '2026-09-10T12:00:00.000Z' };
    else if (phase === 'launching') state = { schema: 1, phase, launchId: LAUNCH, buildSha: BUILD, runnerPid: 111, runnerBirthId: 'runner-birth', serverPid: 222 };
    else state = { schema: 1, phase: 'stopping', operationId: OTHER_LAUNCH, ownerPid: 111, ownerBirthId: 'runner-birth', target: running() };
    const io = fakeIO(state);
    expect((await dashboardStatus(io)).ok).toBe(false);
    expect(io.healthUrls).toHaveLength(0);
  });

  it('real status detects changed server bytes, changed info bytes, missing server and optional missing info', async () => {
    const files = new Map([['server', Buffer.from('server')], ['info', Buffer.from('info')]]);
    const read = (file: string): Uint8Array => {
      const value = files.get(file);
      if (!value) throw Object.assign(new Error('read failed'), { code: 'ENOENT' });
      return value;
    };
    const recorded = dashboardBuildIdentity('server', 'info', read);
    const io = fakeIO(running({ buildSha: recorded }));
    io.currentBuildIdentity = () => dashboardBuildIdentity('server', 'info', read);
    expect(await dashboardStatus(io)).toEqual({ ok: true, text: 'Health: OK' });
    files.set('server', Buffer.from('changed'));
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: STALE BUILD' });
    files.set('server', Buffer.from('server')); files.set('info', Buffer.from('changed'));
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: STALE BUILD' });
    files.delete('server');
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: BUILD UNREADABLE' });
    files.set('server', Buffer.from('server')); files.delete('info');
    const serverOnly = dashboardBuildIdentity('server', 'info', read);
    io.state = running({ buildSha: serverOnly });
    expect(await dashboardStatus(io)).toEqual({ ok: true, text: 'Health: OK' });
  });

  it('status reports stale and unreadable current builds without mutating state', async () => {
    const io = fakeIO(running({ buildSha: OTHER_BUILD }));
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: STALE BUILD' });
    expect(io.state?.phase).toBe('running');
    io.buildError = new Error('secret path');
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: BUILD UNREADABLE' });
    expect(io.state?.phase).toBe('running');
  });

  it('dead stale state is removed', async () => {
    const io = fakeIO(running({ pid: 999 }));
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: STOPPED' });
    expect(io.state).toBeNull();
  });

  it('cleans launching only when both runner and recorded server are proved gone', async () => {
    const gone = fakeIO({ schema: 1, phase: 'launching', launchId: LAUNCH, buildSha: BUILD, runnerPid: 998,
      runnerBirthId: 'old', serverPid: 999 });
    expect(await dashboardStatus(gone)).toEqual({ ok: false, text: 'Health: STOPPED' });
    expect(gone.state).toBeNull();
    const unknown = fakeIO({ schema: 1, phase: 'launching', launchId: LAUNCH, buildSha: BUILD, runnerPid: 998,
      runnerBirthId: 'old', serverPid: null });
    expect(await dashboardStatus(unknown)).toEqual({ ok: false, text: 'Health: LAUNCHING' });
    expect(unknown.state?.phase).toBe('launching');
  });

  it('cleans a stopping phase whose exact target is already gone', async () => {
    const target = running({ pid: 999 });
    const io = fakeIO({ schema: 1, phase: 'stopping', operationId: OTHER_LAUNCH, ownerPid: 998,
      ownerBirthId: 'old', target });
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: STOPPED' });
    expect(io.state).toBeNull();
  });

  it('takes over a stopping operation only after its owner is proved dead', async () => {
    const target = running();
    const io = fakeIO({ schema: 1, phase: 'stopping', operationId: LAUNCH, ownerPid: 998,
      ownerBirthId: 'old', target });
    expect(await dashboardStop(io)).toContain('stopped');
    expect(io.signals).toEqual([{ pid: 222, authorized: true }]);
  });

  it('does not displace a stopping operation whose owner is live or unprovable', async () => {
    const target = running();
    const io = fakeIO({ schema: 1, phase: 'stopping', operationId: LAUNCH, ownerPid: 111,
      ownerBirthId: 'runner-birth', target });
    await expect(dashboardStop(io)).rejects.toThrow('stop in progress');
    expect(io.signals).toHaveLength(0);
    expect(io.state?.phase).toBe('stopping');
  });

  it('revalidates the full state after reading the current build', async () => {
    const io = fakeIO(running());
    io.currentBuildIdentity = () => {
      io.state = running({ launchId: OTHER_LAUNCH });
      return BUILD;
    };
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: STATE CHANGED' });
    expect(io.state).toEqual(running({ launchId: OTHER_LAUNCH }));
  });

  it('start timeout stops its matching proved running server', async () => {
    vi.useFakeTimers();
    const base = Date.parse('2026-09-10T12:00:00.000Z');
    const io = fakeIO();
    io.now = () => new Date(base + performance.now());
    io.spawnDetached = spec => {
      io.detached.push(spec);
      io.state = running({ launchId: OTHER_LAUNCH, buildSha: BUILD });
      return 333;
    };
    io.projectsHealth = async () => false;
    const result = dashboardStart(io);
    await vi.advanceTimersByTimeAsync(8_500);
    await expect(result).rejects.toThrow('did not become healthy');
    expect(io.signals).toEqual([{ pid: 222, authorized: true }]);
    expect(io.state).toBeNull();
  });

  it('verified-unhealthy start terminates the proved server and refuses same-invocation replacement', async () => {
    const io = fakeIO(running());
    io.projectsHealth = async () => false;
    await expect(dashboardStart(io)).rejects.toThrow('verified server stopped');
    expect(io.signals).toEqual([{ pid: 222, authorized: true }]);
    expect(io.detached).toHaveLength(0);
    expect(io.state).toBeNull();
  });

  it('build-mismatch start refuses stale idempotency and same-invocation replacement', async () => {
    const io = fakeIO(running({ buildSha: OTHER_BUILD }));
    await expect(dashboardStart(io)).rejects.toThrow('verified server stopped');
    expect(io.signals).toEqual([{ pid: 222, authorized: true }]);
    expect(io.detached).toHaveLength(0);
    expect(io.state).toBeNull();
  });

  it('stop proves the four-part identity before terminating', async () => {
    const io = fakeIO(running());
    expect(await dashboardStop(io)).toBe('mai-brain-web stopped, pid=222');
    expect(io.signals).toEqual([{ pid: 222, authorized: true }]);
    expect(io.state).toBeNull();
  });

  it.each(['birth', 'launch', 'null-birth', 'null-launch'])('stop fails closed for foreign %s identity', async defect => {
    const io = fakeIO(running());
    const originalBirth = io.processOps.processBirthId;
    const originalLaunch = io.processOps.processLaunchId;
    if (defect === 'birth') io.processOps.processBirthId = async pid => pid === 222 ? 'recycled' : originalBirth(pid);
    if (defect === 'null-birth') io.processOps.processBirthId = async pid => pid === 222 ? null : originalBirth(pid);
    if (defect === 'launch') io.processOps.processLaunchId = async () => OTHER_LAUNCH;
    if (defect === 'null-launch') io.processOps.processLaunchId = async () => null;
    await expect(dashboardStop(io)).rejects.toThrow('foreign or stale');
    expect(io.signals).toHaveLength(0);
    expect(io.state?.phase).toBe('running');
    io.processOps.processLaunchId = originalLaunch;
  });

  it('stop does not require current build files', async () => {
    const io = fakeIO(running());
    io.buildError = new Error('missing build');
    expect(await dashboardStop(io)).toContain('stopped');
  });

  it('retains stopping while delivery is unresolved and finalizes afterward', async () => {
    const io = fakeIO(running());
    const operation = await reserveStop(running(), io);
    expect(operation).not.toBeNull();
    if (!operation) throw new Error('missing operation');
    let release: () => void = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const result = executeStop(operation, io, async authorize => {
      expect(await authorize()).toBe(true);
      await barrier;
      await io.processOps.terminateTree(222, authorize);
    });
    expect(io.state?.phase).toBe('stopping');
    release();
    expect(await result).toEqual({ stopped: true, error: null });
  });

  it('another verb observes stopping while termination remains unresolved', async () => {
    const io = fakeIO(running());
    const operation = await reserveStop(running(), io);
    if (!operation) throw new Error('missing operation');
    let release: () => void = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const stopping = executeStop(operation, io, async authorize => {
      expect(await authorize()).toBe(true);
      await barrier;
      await io.processOps.terminateTree(222, authorize);
    });
    expect(await dashboardStatus(io)).toEqual({ ok: false, text: 'Health: STOPPING' });
    release();
    expect(await stopping).toEqual({ stopped: true, error: null });
  });

  it('ineffective termination is bounded by the adapter and preserves the running target', async () => {
    const io = fakeIO(running());
    io.processOps.terminateTree = async (_pid, authorize) => {
      if (!await authorize?.()) throw new Error('authorization refused');
    };
    await expect(dashboardStop(io)).rejects.toThrow('dashboard remains alive; state preserved');
    expect(io.state).toEqual(running());
  });

  it('recycled identity between TERM and KILL prevents escalation and preserves state', async () => {
    const io = fakeIO(running());
    const operation = await reserveStop(running(), io);
    if (!operation) throw new Error('missing operation');
    let recycled = false;
    const birth = io.processOps.processBirthId;
    io.processOps.processBirthId = async pid => recycled && pid === 222 ? 'recycled-birth' : birth(pid);
    const result = await executeStop(operation, io, async authorize => {
      expect(await authorize()).toBe(true);
      recycled = true;
      if (await authorize()) throw new Error('recycled identity authorized');
      throw new Error('process tree authorization refused');
    });
    expect(result.stopped).toBe(true);
    expect(result.error?.message).toBe('process tree authorization refused');
    expect(io.state).toBeNull();
  });

  it('malformed state fails closed through every public verb', async () => {
    const verbs = [
      (io: DashboardIO) => dashboardStart(io),
      (io: DashboardIO) => dashboardRun({}, io),
      (io: DashboardIO) => dashboardStatus(io),
      (io: DashboardIO) => dashboardStop(io),
    ];
    for (const verb of verbs) {
      const io = fakeIO();
      io.readState = () => { throw new Error('dashboard state is malformed'); };
      await expect(verb(io)).rejects.toThrow('dashboard state is malformed');
      expect(io.specs).toHaveLength(0);
      expect(io.detached).toHaveLength(0);
      expect(io.signals).toHaveLength(0);
    }
  });

  it('bounds a hanging health fetch and keeps the token out of errors', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('secret-token'), { name: 'AbortError' })));
    })));
    // The adapter resolves its state paths eagerly, and on Windows that needs
    // LOCALAPPDATA unless MAI_STATE_HOME is explicit: root it in this test's own
    // temp dir so the fixture env stays minimal on every platform.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai dashboard health '));
    try {
      const io = defaultDashboardIO({ MAI_BRAIN_WEB_TOKEN: 'secret-token', MAI_STATE_HOME: root });
      const request = io.launcherHealth('http://127.0.0.1:6601', 'secret-token');
      const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(501);
      await rejection;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('failed delivery restores the exact running target', async () => {
    const io = fakeIO(running());
    const operation = await reserveStop(running(), io);
    if (!operation) throw new Error('missing operation');
    const result = await executeStop(operation, io, async () => { throw new Error('delivery failed'); });
    expect(result.stopped).toBe(false);
    expect(result.error?.message).toBe('delivery failed');
    expect(io.state).toEqual(running());
  });

  it('a changed operation is never erased by finalization', async () => {
    const io = fakeIO(running());
    const operation = await reserveStop(running(), io);
    if (!operation) throw new Error('missing operation');
    const replacement = { ...operation, operationId: LAUNCH };
    const result = await executeStop(operation, io, async () => { io.state = replacement; });
    expect(result.stopped).toBe(false);
    expect(io.state).toEqual(replacement);
  });

  it('start refuses before state access when path preparation fails', async () => {
    const io = fakeIO();
    io.preparePaths = () => { throw new Error('unsafe managed path'); };
    await expect(dashboardStart(io)).rejects.toThrow('unsafe managed path');
    expect(io.stateReads).toBe(0);
    expect(io.detached).toHaveLength(0);
  });

  it('a lock acquisition failure launches nothing', async () => {
    const io = fakeIO();
    io.withStateLock = async () => { throw new Error('could not lock dashboard state'); };
    await expect(dashboardStart(io)).rejects.toThrow('could not lock dashboard state');
    expect(io.detached).toHaveLength(0);
  });

  it('a reservation lock-release failure is surfaced with state preserved and no spawn', async () => {
    const io = fakeIO();
    io.withStateLock = async fn => { await fn(); throw new LockReleaseError('release failed'); };
    await expect(dashboardStart(io)).rejects.toThrow('release failed');
    expect(io.state?.phase).toBe('reserved');
    expect(io.detached).toHaveLength(0);
  });

  it('two concurrent starts produce one runner spawn and one owned state', async () => {
    const io = fakeIO();
    const [first, second] = await Promise.all([dashboardStart(io), dashboardStart(io)]);
    expect(first + second).toContain('started');
    expect(io.detached).toHaveLength(1);
    expect(io.state?.phase).toBe('running');
  });

  it('dashboardStatusBuild redacts build-read failures', () => {
    expect(dashboardStatusBuild({ currentBuildIdentity: () => BUILD }, BUILD)).toEqual({ ok: true, text: 'Health: OK' });
    expect(dashboardStatusBuild({ currentBuildIdentity: () => OTHER_BUILD }, BUILD)).toEqual({ ok: false, text: 'Health: STALE BUILD' });
    expect(dashboardStatusBuild({ currentBuildIdentity: () => { throw new Error('private path'); } }, BUILD)).toEqual({ ok: false, text: 'Health: BUILD UNREADABLE' });
  });
});
