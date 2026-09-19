import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeTool } from './support/fake-tool.js';
import { dashboardBuildIdentity, dashboardStatusBuild } from '../scripts/dashboard.js';
import {
  LAUNCHD_LABEL,
  SCHEDULER_NAME,
  createPersistenceSupervisor,
  renderPersistence,
  runPersistenceWithDependencies,
  type PersistenceDependencies,
  type PersistencePaths,
  type PersistenceRenderResult,
  type PersistenceSupervisor,
  type SupervisorState,
} from '../scripts/dashboard-persistence.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const temporaries: string[] = [];

// The verified management flow is one platform-parameterised body (install,
// rollback, health, stop, uninstall) that both supported platforms run, so it is
// pinned to the HOST: the product resolves its own state paths through the host's
// path flavour and containment rules, which makes a foreign pin unrunnable rather
// than more thorough. macOS keeps the darwin expectations byte-for-byte.
const HOST: 'darwin' | 'win32' = process.platform === 'win32' ? 'win32' : 'darwin';
const INSTALLED_TEXT = HOST === 'darwin'
  ? `Installed ${LAUNCHD_LABEL}`
  : `Installed ${SCHEDULER_NAME} (restart interval PT1M, retry count 255)`;
/** Proof the installed definition is the host's own supervisor, not the other one. */
const DEFINITION_MARKER = HOST === 'darwin'
  ? `<key>Label</key><string>${LAUNCHD_LABEL}</string>`
  : '<Interval>PT1M</Interval><Count>255</Count>';

function temporary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-persistence-'));
  temporaries.push(dir);
  return dir;
}

/**
 * A temporary directory in POSIX form, for fixtures handed to product code that
 * is pinned to `darwin`: darwin-flavoured validation demands a path
 * `path.posix.isAbsolute` accepts, which a drive-qualified Windows temp dir is not.
 * On win32 a leading-slash path is drive-relative — Node resolves it against the
 * drive of `process.cwd()` — so the directory must live on that same drive (CI
 * checks out on D: while TEMP is on C:), and the returned form drops the `X:`
 * prefix and turns `\` into `/`. The native path is what `afterEach` removes.
 */
function posixTemporary(): string {
  if (process.platform !== 'win32') return temporary();
  const cwdDrive = path.win32.parse(process.cwd()).root;
  const parent = path.win32.parse(os.tmpdir()).root.toLowerCase() === cwdDrive.toLowerCase()
    ? os.tmpdir()
    : cwdDrive;
  const dir = fs.mkdtempSync(path.join(parent, 'mai-persistence-'));
  temporaries.push(dir);
  return dir.replace(/^[A-Za-z]:/u, '').replaceAll('\\', '/');
}

function fakeTool(root: string, name: string, body: string): string {
  return installFakeTool(root, name, `set -euo pipefail\n${body}`);
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function renderPaths(root: string, platform: NodeJS.Platform): PersistencePaths {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return {
    root,
    definition: paths.join(root, platform === 'win32' ? `${SCHEDULER_NAME}.xml` : `${LAUNCHD_LABEL}.plist`),
    environment: paths.join(root, 'service.env'),
    dashboardLog: paths.join(root, 'dashboard.log'),
    supervisorOut: paths.join(root, 'supervisor.out.log'),
    supervisorErr: paths.join(root, 'supervisor.err.log'),
  };
}

class FakeSupervisor implements PersistenceSupervisor {
  state: SupervisorState = {
    installed: false, running: false, identityVerified: true, owner: 'test-user',
    runLevel: 'Limited', nextRun: 'next logon', lastResult: '0', retryStatus: 'none',
  };
  calls: string[] = [];
  registerFailure: Error | null = null;
  startFailure: Error | null = null;
  stopFailure: Error | null = null;
  unregisterFailure: Error | null = null;
  startHook: (() => void) | null = null;
  stopHook: (() => void) | null = null;

  async inspect(_expected: PersistenceRenderResult | null): Promise<SupervisorState> {
    this.calls.push('inspect');
    return { ...this.state };
  }
  async register(): Promise<void> {
    this.calls.push('register');
    if (this.registerFailure) throw this.registerFailure;
    this.state.installed = true;
  }
  async start(): Promise<void> {
    this.calls.push('start');
    if (this.startFailure) throw this.startFailure;
    this.state.running = true;
    this.startHook?.();
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
    if (this.stopFailure) throw this.stopFailure;
    this.state.running = false;
    this.stopHook?.();
  }
  async unregister(): Promise<void> {
    this.calls.push('unregister');
    if (this.unregisterFailure) throw this.unregisterFailure;
    this.state.installed = false;
  }
}

interface Harness {
  base: string;
  checkout: string;
  home: string;
  stateHome: string;
  env: NodeJS.ProcessEnv;
  supervisor: FakeSupervisor;
  dependencies: PersistenceDependencies;
  statusText: string;
  statusOk: boolean;
  statusEnvironments: NodeJS.ProcessEnv[];
  statusResponses: Array<{ ok: boolean; text: string }>;
  sleepCalls: number[];
  listener: string | null;
}

function harness(): Harness {
  const base = temporary();
  const checkout = path.join(base, "checkout & 'quoted'");
  const home = path.join(base, 'home');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(path.join(checkout, 'build'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'build', 'entry.js'), 'entry');
  fs.writeFileSync(path.join(checkout, 'build', 'web-server.js'), 'server');
  fs.writeFileSync(path.join(checkout, 'build', 'build-info.json'), '{}');
  fs.mkdirSync(home, { recursive: true });
  const supervisor = new FakeSupervisor();
  const value: Harness = {
    base, checkout, home, stateHome,
    env: { HOME: home, MAI_STATE_HOME: stateHome, PATH: '/usr/bin' },
    supervisor,
    statusText: 'Health: OK', statusOk: true, statusEnvironments: [], statusResponses: [],
    sleepCalls: [], listener: null,
    dependencies: {
      nodePath: '/absolute/node', username: 'test-user',
      supervisor: () => supervisor,
      async status(environment) {
        value.statusEnvironments.push({ ...environment });
        const response = value.statusResponses.shift();
        if (response) return response;
        return { ok: value.statusOk, text: value.statusText };
      },
      async listener() { return value.listener; },
      async sleep(milliseconds) { value.sleepCalls.push(milliseconds); },
      publish(source, target) { fs.renameSync(source, target); },
    },
  };
  return value;
}

async function install(value: Harness, platform: NodeJS.Platform = HOST) {
  return runPersistenceWithDependencies('install', {
    platform, env: value.env, checkoutRoot: value.checkout,
  }, value.dependencies);
}

/**
 * A win32 restart ends the running scheduled task first and polls for the exact
 * stopped text before starting again; a darwin restart reloads in place. Queue
 * that extra probe only where the host consumes one, so the health and sleep
 * expectations below stay identical on both platforms.
 */
function queueRestartStopProbe(value: Harness): void {
  if (HOST === 'win32') value.statusResponses.push({ ok: false, text: 'Health: STOPPED' });
}

function installedPaths(value: Harness, platform: NodeJS.Platform): PersistencePaths {
  const root = path.join(value.stateHome, 'dashboard-persistence');
  return {
    root,
    definition: platform === 'darwin'
      ? path.join(value.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
      : path.join(root, `${SCHEDULER_NAME}.xml`),
    environment: path.join(root, 'service.env'),
    dashboardLog: path.join(value.stateHome, 'dashboard.log'),
    supervisorOut: path.join(root, 'supervisor.out.log'),
    supervisorErr: path.join(root, 'supervisor.err.log'),
  };
}

describe('deterministic supervisor rendering', () => {
  it('renders a token-free launchd definition and allowlisted private environment', () => {
    const root = "/tmp/mai & brain's checkout";
    const result = renderPersistence({
      platform: 'darwin', checkoutRoot: root, nodePath: '/opt/Node & Co/node', username: 'tester',
      paths: renderPaths(root, 'darwin'),
      environment: {
        MAI_DB_URL: 'postgresql://user:p%40ss@127.0.0.1/db',
        MAI_BRAIN_WEB_PORT: '16601', MAI_BRAIN_WEB_BIND: '0.0.0.0',
        MAI_BRAIN_WEB_TOKEN: 'token-canary+/=', OPENAI_API_KEY: 'provider-canary',
        AWS_SECRET_ACCESS_KEY: 'must-not-survive',
      },
    });
    expect(result.definition).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(result.definition).toContain('<key>KeepAlive</key><true/>');
    expect(result.definition).toContain('<key>RunAtLoad</key><true/>');
    expect(result.definition).toContain('<key>ThrottleInterval</key><integer>30</integer>');
    expect(result.definition).toContain('mai &amp; brain&apos;s checkout');
    expect(result.args.slice(-4)).toEqual(['dashboard', 'run', '--env-file', result.args.at(-1)]);
    expect(result.privateEnvironment).toContain('MAI_BRAIN_WEB_URL=http://127.0.0.1:16601');
    expect(result.privateEnvironment).toContain('MAI_BRAIN_WEB_TOKEN=token-canary+/=');
    expect(result.privateEnvironment).toContain('OPENAI_API_KEY=provider-canary');
    expect(`${result.definition}\n${result.args.join(' ')}`).not.toContain('token-canary');
    expect(result.privateEnvironment).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('renders the exact Windows interactive limited PT1M/255 definition', () => {
    const root = 'C:\\Users\\Test User\\mai & brain';
    const result = renderPersistence({
      platform: 'win32', checkoutRoot: root, nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      username: 'DOMAIN\\Test & User', paths: renderPaths(root, 'win32'),
      environment: { MAI_BRAIN_WEB_BIND: '192.0.2.10', MAI_BRAIN_WEB_URL: 'http://192.0.2.10:6601', MAI_BRAIN_WEB_TOKEN: 'token-canary' },
    });
    expect(result.definition).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result.definition).toContain('<Interval>PT1M</Interval><Count>255</Count>');
    expect(result.definition).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(result.definition).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(result.definition).not.toContain('<Password>');
    expect(result.definition).toContain('C:\\Program Files\\nodejs\\node.exe');
    expect(result.definition).toContain('dashboard run --env-file');
    expect(result.definition).not.toContain('dashboard start');
    expect(result.definition).not.toContain('token-canary');
    expect(result.privateEnvironment).toContain('MAI_BRAIN_WEB_URL=http://192.0.2.10:6601');
  });

  it.each(['darwin', 'win32'] as const)('renders %s definitions byte-identically for identical input', platform => {
    const root = platform === 'win32' ? 'C:\\Users\\Test User\\mai' : '/tmp/Test User/mai';
    const input = {
      platform, checkoutRoot: root,
      nodePath: platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/opt/node/bin/node',
      username: 'test-user', paths: renderPaths(root, platform),
      environment: { MAI_BRAIN_WEB_PORT: '6601', MAI_BRAIN_WEB_TOKEN: 'deterministic-canary' },
    };
    expect(renderPersistence(input)).toEqual(renderPersistence(input));
  });

  it('kills PT30S and missing-count scheduler mutants', () => {
    const root = 'C:\\mai';
    const rendered = renderPersistence({ platform: 'win32', checkoutRoot: root,
      nodePath: 'C:\\node.exe', username: 'user', paths: renderPaths(root, 'win32'), environment: {} }).definition;
    const acceptsPolicy = (definition: string) => definition.includes('<Interval>PT1M</Interval>')
      && definition.includes('<Count>255</Count>') && !definition.includes('<Interval>PT30S</Interval>');
    expect(acceptsPolicy(rendered)).toBe(true);
    expect(acceptsPolicy(rendered.replace('PT1M', 'PT30S'))).toBe(false);
    expect(acceptsPolicy(rendered.replace('<Count>255</Count>', ''))).toBe(false);
  });

  it.each([
    ['127.0.0.1', 'http://127.0.0.1:7123'], ['0.0.0.0', 'http://127.0.0.1:7123'],
    ['::', 'http://[::1]:7123'], ['[::1]', 'http://[::1]:7123'],
  ])('serializes the shared resolver result for %s', (bind, expected) => {
    const result = renderPersistence({ platform: 'darwin', checkoutRoot: '/tmp/mai', nodePath: '/bin/node',
      username: 'user', paths: renderPaths('/tmp/mai', 'darwin'),
      environment: { MAI_BRAIN_WEB_BIND: bind, MAI_BRAIN_WEB_PORT: '7123' } });
    expect(result.healthUrl).toBe(expected);
    expect(result.privateEnvironment).toContain(`MAI_BRAIN_WEB_URL=${expected}`);
  });

  it.each(['http://user:pass@example.test', 'ftp://example.test', 'http://example.test/ bad'])
  ('rejects invalid explicit URLs without reflecting them', invalid => {
    const invoke = () => renderPersistence({ platform: 'darwin', checkoutRoot: '/tmp/mai', nodePath: '/bin/node',
      username: 'user', paths: renderPaths('/tmp/mai', 'darwin'), environment: { MAI_BRAIN_WEB_URL: invalid } });
    expect(invoke).toThrow('MAI_BRAIN_WEB_URL must be an http(s) URL without credentials');
    try { invoke(); } catch (error) { expect(String(error)).not.toContain(invalid); }
  });

  it('rejects a specific bind without an explicit URL before rendering', () => {
    expect(() => renderPersistence({ platform: 'darwin', checkoutRoot: '/tmp/mai', nodePath: '/bin/node',
      username: 'user', paths: renderPaths('/tmp/mai', 'darwin'), environment: { MAI_BRAIN_WEB_BIND: '192.0.2.10' } }))
      .toThrow('set MAI_BRAIN_WEB_URL');
  });

  it('rejects unsupported platforms, relative paths, invalid ports, and control characters', () => {
    const input = { platform: 'darwin' as const, checkoutRoot: '/tmp/mai', nodePath: '/bin/node',
      username: 'user', paths: renderPaths('/tmp/mai', 'darwin'), environment: {} };
    expect(() => renderPersistence({ ...input, platform: 'linux' })).toThrow('supported only');
    expect(() => renderPersistence({ ...input, checkoutRoot: 'relative' })).toThrow('must be absolute');
    expect(() => renderPersistence({ ...input, environment: { MAI_BRAIN_WEB_PORT: '0' } })).toThrow('invalid dashboard port');
    expect(() => renderPersistence({ ...input, environment: { MAI_BRAIN_WEB_TOKEN: 'bad\nvalue' } })).toThrow('control character');
  });
});

describe('verified persistence management', () => {
  it('installs a mode-0600 pair and starts the exact supervisor', async () => {
    const value = harness();
    value.env.MAI_BRAIN_WEB_TOKEN = 'token-canary';
    value.env.AWS_SECRET_ACCESS_KEY = 'ambient-canary';
    const result = await install(value);
    const paths = installedPaths(value, HOST);
    expect(result).toEqual({ ok: true, text: `${INSTALLED_TEXT}\nHealth: OK` });
    expect(value.supervisor.calls).toEqual(['inspect', 'register', 'start']);
    if (process.platform !== 'win32') { // Windows has no POSIX mode bits; the product skips mode enforcement there.
      expect(fs.statSync(paths.definition).mode & 0o777).toBe(0o600);
      expect(fs.statSync(paths.environment).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(paths.definition, 'utf8')).toContain(DEFINITION_MARKER);
    expect(fs.readFileSync(paths.definition, 'utf8')).not.toContain('token-canary');
    const definitionBytes = fs.readFileSync(paths.definition);
    expect(definitionBytes.subarray(0, 38).toString('utf8')).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(definitionBytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(value.statusEnvironments.at(-1)?.MAI_BRAIN_WEB_TOKEN).toBe('token-canary');
    expect(value.statusEnvironments.at(-1)?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('uses inherited values over .env and round-trips the explicit URL into health', async () => {
    const value = harness();
    fs.writeFileSync(path.join(value.checkout, '.env'), 'MAI_BRAIN_WEB_PORT=7000\nMAI_BRAIN_WEB_URL=http://127.0.0.1:7000\n');
    value.env.MAI_BRAIN_WEB_PORT = '6601';
    value.env.MAI_BRAIN_WEB_BIND = '192.0.2.10';
    value.env.MAI_BRAIN_WEB_URL = 'http://192.0.2.10:6601';
    expect((await install(value)).ok).toBe(true);
    expect(value.statusEnvironments.at(-1)?.MAI_BRAIN_WEB_URL).toBe('http://192.0.2.10:6601');
    value.supervisor.calls.length = 0;
    expect((await runPersistenceWithDependencies('status', { platform: HOST, env: value.env }, value.dependencies)).ok).toBe(true);
    expect(value.statusEnvironments.at(-1)?.MAI_BRAIN_WEB_URL).toBe('http://192.0.2.10:6601');
    queueRestartStopProbe(value);
    expect((await runPersistenceWithDependencies('restart', { platform: HOST, env: value.env }, value.dependencies)).ok).toBe(true);
    expect(value.statusEnvironments.at(-1)?.MAI_BRAIN_WEB_URL).toBe('http://192.0.2.10:6601');
    value.statusOk = false; value.statusText = 'Health: STOPPED';
    expect((await runPersistenceWithDependencies('stop', { platform: HOST, env: value.env }, value.dependencies)).ok).toBe(true);
    expect(value.statusEnvironments.at(-1)?.MAI_BRAIN_WEB_URL).toBe('http://192.0.2.10:6601');
  });

  it('refuses a non-loopback bind without URL before supervisor mutation', async () => {
    const value = harness();
    value.env.MAI_BRAIN_WEB_BIND = '192.0.2.10';
    const result = await install(value);
    expect(result.ok).toBe(false);
    expect(value.supervisor.calls).toEqual([]);
  });

  it('refuses an untracked listener before publication or signalling', async () => {
    const value = harness();
    value.listener = 'foreign pid 44';
    const result = await install(value);
    expect(result.text).toContain('untracked dashboard listener');
    expect(value.supervisor.calls).toEqual(['inspect']);
    expect(fs.existsSync(installedPaths(value, HOST).definition)).toBe(false);
  });

  it('restores both previous bytes when second-half publication fails', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    const paths = installedPaths(value, HOST);
    const oldDefinition = fs.readFileSync(paths.definition);
    const oldEnvironment = fs.readFileSync(paths.environment);
    value.env.MAI_BRAIN_WEB_PORT = '7777';
    value.dependencies.publish = (source, target, ordinal) => {
      if (ordinal === 2) throw new Error('second-half failure');
      fs.renameSync(source, target);
    };
    const result = await install(value);
    expect(result).toEqual({ ok: false, text: 'persistence install failed: second-half failure; prior pair restored' });
    expect(fs.readFileSync(paths.definition)).toEqual(oldDefinition);
    expect(fs.readFileSync(paths.environment)).toEqual(oldEnvironment);
  });

  it('reloads a previously running pair when first-half publication fails after stop', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    const paths = installedPaths(value, HOST);
    const oldDefinition = fs.readFileSync(paths.definition);
    value.dependencies.publish = () => { throw new Error('first-half failure'); };
    value.supervisor.calls.length = 0;
    const result = await install(value);
    expect(result.text).toContain('first-half failure; prior pair restored');
    expect(value.supervisor.calls).toEqual(['inspect', 'stop', 'stop', 'unregister', 'register', 'start']);
    expect(fs.readFileSync(paths.definition)).toEqual(oldDefinition);
  });

  it.each(['register', 'health'] as const)('rolls a first install back when %s fails', async failure => {
    const value = harness();
    if (failure === 'register') value.supervisor.registerFailure = new Error('register failure');
    else { value.statusOk = false; value.statusText = 'Health: UNHEALTHY'; }
    const result = await install(value);
    expect(result.ok).toBe(false);
    const paths = installedPaths(value, HOST);
    expect(fs.existsSync(paths.definition)).toBe(false);
    expect(fs.existsSync(paths.environment)).toBe(false);
  });

  it('polls install and restart health through transient launching states', async () => {
    const value = harness();
    value.statusResponses.push(
      { ok: false, text: 'Health: LAUNCHING' },
      { ok: false, text: 'Health: STOPPED' },
      { ok: true, text: 'Health: OK' },
    );
    expect(await install(value)).toMatchObject({ ok: true, text: expect.stringContaining('Health: OK') });
    expect(value.sleepCalls).toEqual([500, 500]);

    value.sleepCalls.length = 0;
    queueRestartStopProbe(value);
    value.statusResponses.push(
      { ok: false, text: 'Health: LAUNCHING' },
      { ok: true, text: 'Health: OK' },
    );
    expect(await runPersistenceWithDependencies(
      'restart', { platform: HOST, env: value.env }, value.dependencies,
    )).toEqual({ ok: true, text: 'Health: OK' });
    expect(value.sleepCalls).toEqual([500]);
  });

  it('rolls install back only after the bounded health wait and preserves the last diagnostic', async () => {
    const value = harness();
    value.statusOk = false;
    value.statusText = 'Health: STARTUP FAILED';
    const result = await install(value);
    expect(result).toEqual({
      ok: false,
      text: 'persistence install failed: installed dashboard did not become healthy: Health: STARTUP FAILED; prior pair restored',
    });
    expect(value.statusEnvironments).toHaveLength(61);
    expect(value.sleepCalls).toEqual(Array.from({ length: 60 }, () => 500));
  });

  it('reports both the install failure and rollback reload failure', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    value.dependencies.publish = (source, target, ordinal) => {
      if (ordinal === 2) throw new Error('primary failure');
      fs.renameSync(source, target);
    };
    value.supervisor.registerFailure = new Error('rollback reload failure');
    const result = await install(value);
    expect(result.text).toContain('primary failure');
    expect(result.text).toContain('rollback failed: rollback reload failure');
  });

  it('leaves the installed pair untouched when supervisor inspection is unknown', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    const paths = installedPaths(value, HOST);
    const before = fs.readFileSync(paths.definition);
    value.dependencies.supervisor = () => ({
      async inspect() { throw new Error('unknown supervisor failure'); },
      async register() {}, async start() {}, async stop() {}, async unregister() {},
    });
    expect((await install(value)).ok).toBe(false);
    expect(fs.readFileSync(paths.definition)).toEqual(before);
  });

  it('reports current, stale, and unreadable build health without re-registering', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    for (const [ok, text] of [[true, 'Health: OK'], [false, 'Health: STALE BUILD'], [false, 'Health: BUILD UNREADABLE']] as const) {
      value.statusOk = ok; value.statusText = text; value.supervisor.calls.length = 0;
      const result = await runPersistenceWithDependencies('status', { platform: HOST, env: value.env }, value.dependencies);
      expect(result.ok).toBe(ok);
      expect(result.text).toContain(text);
      expect(value.supervisor.calls).toEqual(['inspect']);
    }
  });

  it('makes changed-server, changed-stamp, and unreadable builds unhealthy through the shared build proof', async () => {
    const value = harness();
    const server = path.join(value.checkout, 'build', 'web-server.js');
    const stamp = path.join(value.checkout, 'build', 'build-info.json');
    const recordedBuild = dashboardBuildIdentity(server, stamp);
    value.dependencies.status = async () => dashboardStatusBuild({
      currentBuildIdentity: () => dashboardBuildIdentity(server, stamp),
    }, recordedBuild);
    expect((await install(value)).ok).toBe(true);
    const status = async () => runPersistenceWithDependencies(
      'status', { platform: HOST, env: value.env }, value.dependencies,
    );
    const initialStatus = await status();
    expect(initialStatus.ok).toBe(true);
    const initial = initialStatus.text.match(/Current build: ([0-9a-f:]+)/u)?.[1];
    expect(initial).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/u);
    fs.writeFileSync(server, 'changed-server');
    const changedServerStatus = await status();
    expect(changedServerStatus).toMatchObject({ ok: false });
    expect(changedServerStatus.text).toContain('Health: STALE BUILD');
    const serverChanged = changedServerStatus.text.match(/Current build: ([0-9a-f:]+)/u)?.[1];
    expect(serverChanged).not.toBe(initial);
    fs.writeFileSync(server, 'server');
    fs.writeFileSync(stamp, '{"changed":true}');
    const changedStampStatus = await status();
    expect(changedStampStatus).toMatchObject({ ok: false });
    expect(changedStampStatus.text).toContain('Health: STALE BUILD');
    const stampChanged = changedStampStatus.text.match(/Current build: ([0-9a-f:]+)/u)?.[1];
    expect(stampChanged).not.toBe(serverChanged);
    fs.rmSync(server);
    const unreadableStatus = await status();
    expect(unreadableStatus).toMatchObject({ ok: false });
    expect(unreadableStatus.text).toContain('Current build: unreadable');
    expect(unreadableStatus.text).toContain('Health: BUILD UNREADABLE');
  });

  it('reports scheduler retry exhaustion without re-registration and explicit restart starts it', async () => {
    const value = harness();
    value.env.SystemRoot = 'C:\\Windows'; value.env.USERPROFILE = 'C:\\Users\\test';
    expect((await install(value, 'win32')).ok).toBe(true);
    expect(value.statusEnvironments.at(-1)?.SystemRoot).toBe('C:\\Windows');
    value.supervisor.state.running = false;
    value.supervisor.state.retryStatus = 'exhausted';
    value.supervisor.state.lastResult = '1';
    value.supervisor.calls.length = 0;
    const status = await runPersistenceWithDependencies('status', { platform: 'win32', env: value.env }, value.dependencies);
    expect(status.ok).toBe(false);
    expect(status.text).toContain('Retry policy: exhausted');
    expect(value.supervisor.calls).toEqual(['inspect']);
    value.supervisor.calls.length = 0;
    expect((await runPersistenceWithDependencies('restart', { platform: 'win32', env: value.env }, value.dependencies)).ok).toBe(true);
    expect(value.supervisor.calls).toEqual(['inspect', 'start']);
  });

  it('ends a running Windows task before restart and observes the new build identity', async () => {
    const value = harness();
    value.env.SystemRoot = 'C:\\Windows'; value.env.USERPROFILE = 'C:\\Users\\test';
    const server = path.join(value.checkout, 'build', 'web-server.js');
    const stamp = path.join(value.checkout, 'build', 'build-info.json');
    const observedBuilds: string[] = [];
    value.dependencies.status = async () => {
      if (!value.supervisor.state.running) return { ok: false, text: 'Health: STOPPED' };
      observedBuilds.push(dashboardBuildIdentity(server, stamp));
      return { ok: true, text: 'Health: OK' };
    };
    expect((await install(value, 'win32')).ok).toBe(true);
    const originalBuild = observedBuilds.at(-1);
    value.supervisor.startHook = () => fs.writeFileSync(stamp, '{"restart":true}');
    value.supervisor.calls.length = 0;
    const result = await runPersistenceWithDependencies(
      'restart', { platform: 'win32', env: value.env }, value.dependencies,
    );
    expect(result).toEqual({ ok: true, text: 'Health: OK' });
    expect(value.supervisor.calls).toEqual(['inspect', 'stop', 'start']);
    expect(observedBuilds.at(-1)).not.toBe(originalBuild);
  });

  it('stop preserves the installed pair and logs after verified supervisor shutdown', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    const paths = installedPaths(value, HOST);
    fs.writeFileSync(paths.dashboardLog, 'kept');
    value.statusOk = false; value.statusText = 'Health: STOPPED'; value.supervisor.calls.length = 0;
    const result = await runPersistenceWithDependencies('stop', { platform: HOST, env: value.env }, value.dependencies);
    expect(result.ok).toBe(true);
    expect(value.supervisor.calls).toEqual(['inspect', 'stop']);
    expect(fs.existsSync(paths.definition)).toBe(true);
    expect(fs.readFileSync(paths.dashboardLog, 'utf8')).toBe('kept');
  });

  it('refuses to stop or uninstall a foreign exact-name job', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    value.supervisor.state.identityVerified = false;
    for (const action of ['stop', 'uninstall'] as const) {
      value.supervisor.calls.length = 0;
      const result = await runPersistenceWithDependencies(action, { platform: HOST, env: value.env }, value.dependencies);
      expect(result).toEqual({ ok: false, text: 'refusing foreign supervisor identity' });
      expect(value.supervisor.calls).toEqual(['inspect']);
    }
  });

  it('uninstalls only the exact pair while preserving logs and is idempotent', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    const paths = installedPaths(value, HOST);
    fs.writeFileSync(paths.dashboardLog, 'kept');
    fs.writeFileSync(path.join(path.dirname(paths.definition), 'com.mai.foreign.plist'), 'foreign');
    value.statusOk = false; value.statusText = 'Health: STOPPED';
    const first = await runPersistenceWithDependencies('uninstall', { platform: HOST, env: value.env }, value.dependencies);
    expect(first.ok).toBe(true);
    expect(fs.existsSync(paths.definition)).toBe(false);
    expect(fs.existsSync(paths.environment)).toBe(false);
    expect(fs.readFileSync(paths.dashboardLog, 'utf8')).toBe('kept');
    expect(fs.existsSync(path.join(path.dirname(paths.definition), 'com.mai.foreign.plist'))).toBe(true);
    expect((await runPersistenceWithDependencies('uninstall', { platform: HOST, env: value.env }, value.dependencies)).ok).toBe(true);
  });

  it('rejects split state and symlinked installed files', async () => {
    const value = harness();
    const paths = installedPaths(value, HOST);
    fs.mkdirSync(path.dirname(paths.definition), { recursive: true });
    fs.writeFileSync(paths.definition, 'split');
    expect((await runPersistenceWithDependencies('status', { platform: HOST, env: value.env }, value.dependencies)).text)
      .toContain('split installed state');
    fs.rmSync(paths.definition);
    fs.mkdirSync(path.dirname(paths.environment), { recursive: true });
    const target = path.join(value.base, 'foreign'); fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, paths.environment);
    expect((await runPersistenceWithDependencies('status', { platform: HOST, env: value.env }, value.dependencies)).text)
      .toContain('regular non-symlink');
  });

  it('rejects symlinked private directories and a non-private environment file', async () => {
    const value = harness();
    const paths = installedPaths(value, HOST);
    const redirected = path.join(value.base, 'redirected-state');
    fs.mkdirSync(redirected);
    fs.symlinkSync(redirected, value.stateHome);
    expect((await install(value)).text).toContain('unsafe private directory');
    fs.rmSync(value.stateHome);
    expect((await install(value)).ok).toBe(true);
    if (process.platform !== 'win32') { // Windows has no POSIX mode bits; the product skips mode enforcement there.
      fs.chmodSync(paths.environment, 0o644);
      expect((await runPersistenceWithDependencies('status', { platform: HOST, env: value.env }, value.dependencies)).text)
        .toContain('must have mode 600');
    }
  });

  it('rejects a loaded supervisor when its installed pair is absent', async () => {
    const value = harness();
    value.supervisor.state.installed = true;
    value.supervisor.state.running = true;
    const result = await runPersistenceWithDependencies('status', { platform: HOST, env: value.env }, value.dependencies);
    expect(result).toEqual({ ok: false, text: 'supervisor is loaded without its installed file pair' });
    expect(value.supervisor.calls).toEqual(['inspect']);
  });

  it('tails at most 100 lines and rejects a symlinked log', async () => {
    const value = harness();
    expect((await install(value)).ok).toBe(true);
    const paths = installedPaths(value, HOST);
    fs.writeFileSync(paths.dashboardLog, Array.from({ length: 120 }, (_, index) => `line-${index + 1}`).join('\n') + '\n');
    const result = await runPersistenceWithDependencies('logs', { platform: HOST, env: value.env }, value.dependencies);
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain('line-20\n');
    expect(result.text).toContain('line-21\n');
    fs.rmSync(paths.dashboardLog);
    fs.symlinkSync(path.join(value.base, 'foreign-log'), paths.dashboardLog);
    expect((await runPersistenceWithDependencies('logs', { platform: HOST, env: value.env }, value.dependencies)).ok).toBe(false);
  });
});

describe('supervisor command adapters with fake tools', () => {
  it('classifies launchctl exit 113 and emits exact-label lifecycle argv', async () => {
    // The render input is darwin-pinned, so the checkout root must be POSIX; the
    // fake tool and the files it writes stay on the native temp, because the body
    // runs under Git for Windows bash, which maps a leading `/` to its own
    // install root rather than to Node's current drive.
    const root = posixTemporary();
    const tools = temporary();
    const log = path.join(tools, 'launchctl.log');
    const state = path.join(tools, 'launchctl.state');
    const launchctl = fakeTool(tools, 'launchctl', `
printf '%s\n' "$*" >> "${log}"
if [ "$1" = print ]; then
  if [ ! -f "${state}" ]; then
    echo 'Could not find service' >&2
    exit 113
  fi
  cat "${state}"
fi`);
    const env = { ...process.env, MAI_DASHBOARD_LAUNCHCTL: launchctl };
    const supervisor = createPersistenceSupervisor('darwin', env);
    expect(await supervisor.inspect(null)).toMatchObject({ installed: false, running: false });

    const render = renderPersistence({
      platform: 'darwin', checkoutRoot: root, nodePath: '/bin/node', username: 'test-user',
      paths: renderPaths(root, 'darwin'), environment: {},
    });
    const target = `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}/${LAUNCHD_LABEL}`;
    const launchdTranscript = (executable: string, args: readonly string[], workingDirectory = root,
      label = target) => `${label} = {
  program = ${executable}
  arguments = {
    ${[executable, ...args].join('\n    ')}
  }
  working directory = ${workingDirectory}
}\n`;
    fs.writeFileSync(state, launchdTranscript(render.executable, render.args));
    expect(await supervisor.inspect(render)).toMatchObject({ installed: true, running: true, identityVerified: true });

    const identityMutants = [
      launchdTranscript(`${render.executable}-foreign`, render.args),
      launchdTranscript(render.executable, [...render.args, '--foreign']),
      launchdTranscript(render.executable, [render.args[1], render.args[0], ...render.args.slice(2)]),
      launchdTranscript(render.executable, render.args, `${root}-foreign`),
      `gui/501/com.foreign = {
  program = /foreign/node
  arguments = { /foreign/node }
  working directory = /foreign
  note = ${target} ${render.executable} ${render.args.join(' ')} ${root}
}\n`,
    ];
    for (const mutant of identityMutants) {
      fs.writeFileSync(state, mutant);
      expect(await supervisor.inspect(render)).toMatchObject({ installed: true, identityVerified: false });
    }
    fs.writeFileSync(state, launchdTranscript(render.executable, render.args));
    await supervisor.register(path.join(root, `${LAUNCHD_LABEL}.plist`), render);
    await supervisor.start();
    await supervisor.stop();
    await supervisor.unregister();

    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `print ${target}`,
      `print ${target}`,
      `print ${target}`,
      `print ${target}`,
      `print ${target}`,
      `print ${target}`,
      `print ${target}`,
      `bootstrap ${target.slice(0, target.lastIndexOf('/'))} ${path.join(root, `${LAUNCHD_LABEL}.plist`)}`,
      `kickstart -k ${target}`,
      `bootout ${target}`,
    ]);
  // Every fake launchctl call crosses a Git Bash start-up on Windows (~2 s each
  // through the shim), which overran vitest's 30 s default on the public-package job.
  }, 120_000);

  it('parses fake schtasks status and mutates only the exact scheduled-task name', async () => {
    const root = temporary();
    const log = path.join(root, 'schtasks.log');
    const xmlFile = path.join(root, 'task.xml');
    const statusFile = path.join(root, 'status.json');
    const statusMode = path.join(root, 'status.mode');
    const schtasks = fakeTool(root, 'schtasks.exe', `
printf '%s\n' "$*" >> "${log}"
if [ "$1" = /Query ] && [ "\${4:-}" = /XML ]; then cat "${xmlFile}"; exit 0; fi
if [ "$1" = /Create ]; then
  grep -aq '^<?xml version="1.0" encoding="UTF-8"?>' "$5"
fi`);
    const powershell = fakeTool(root, 'powershell.exe', `
if [ "$(cat "${statusMode}")" = fail ]; then exit 1; fi
cat "${statusFile}"`);
    const windowsRoot = 'C:\\Users\\test\\mai';
    const render = renderPersistence({
      platform: 'win32', checkoutRoot: windowsRoot, nodePath: 'C:\\node.exe', username: 'test-user',
      paths: renderPaths(windowsRoot, 'win32'), environment: {},
    });
    fs.writeFileSync(xmlFile, render.definition);
    fs.writeFileSync(statusMode, 'ok');
    const writeStatus = (overrides: Record<string, unknown> = {}) => fs.writeFileSync(statusFile, JSON.stringify({
      TaskName: SCHEDULER_NAME, TaskPath: '\\', State: 'Running', UserId: 'test-user',
      RunLevel: 'Limited', LogonType: 'Interactive', NextRunTime: null, LastTaskResult: 0,
      ...overrides,
    }));
    writeStatus();
    const env = { ...process.env, MAI_DASHBOARD_SCHTASKS: schtasks, MAI_DASHBOARD_POWERSHELL: powershell };
    const supervisor = createPersistenceSupervisor('win32', env);
    expect(await supervisor.inspect(render)).toMatchObject({
      installed: true, running: true, identityVerified: true, nextRun: 'none', lastResult: '0', retryStatus: 'none',
    });

    for (const definitionMutant of [
      render.definition.replace('<Command>C:\\node.exe</Command>', '<Command>C:\\node.exe-foreign</Command>'),
      render.definition.replace('</Arguments>', ' --foreign</Arguments>'),
      render.definition.replace('dashboard run', 'run dashboard'),
      render.definition.replace('<Command>C:\\node.exe</Command>', '<Command>C:\\foreign.exe</Command>')
        .replace('</Task>', `<Description>C:\\node.exe ${render.args.join(' ')}</Description></Task>`),
    ]) {
      fs.writeFileSync(xmlFile, definitionMutant);
      expect(await supervisor.inspect(render)).toMatchObject({ installed: true, identityVerified: false });
    }
    fs.writeFileSync(xmlFile, render.definition);
    for (const runtimeMutant of [{ UserId: 'foreign-user' }, { RunLevel: 'Highest' }, { LogonType: 'Password' }]) {
      writeStatus(runtimeMutant);
      expect(await supervisor.inspect(render)).toMatchObject({ installed: true, identityVerified: false });
    }

    writeStatus({ State: 'Ready', LastTaskResult: 1, NextRunTime: '2099-01-01T00:00:00.000Z' });
    expect(await supervisor.inspect(render)).toMatchObject({ retryStatus: 'pending' });
    writeStatus({ State: 'Ready', LastTaskResult: 1, NextRunTime: null });
    expect(await supervisor.inspect(render)).toMatchObject({ retryStatus: 'exhausted' });
    writeStatus({ State: 'Ready', LastTaskResult: 0x41306, NextRunTime: null });
    expect(await supervisor.inspect(render)).toMatchObject({ retryStatus: 'stopped' });
    writeStatus({ State: 'En ejecución', LastTaskResult: 1, NextRunTime: 'sin fecha' });
    expect(await supervisor.inspect(render)).toMatchObject({ running: false, retryStatus: 'unknown' });
    fs.writeFileSync(statusMode, 'fail');
    await expect(supervisor.inspect(render)).rejects.toThrow('could not determine scheduled-task status');
    fs.writeFileSync(statusMode, 'ok');
    writeStatus();

    const definition = path.join(root, `${SCHEDULER_NAME}.xml`);
    fs.writeFileSync(definition, render.definition);
    await supervisor.register(definition, render);
    await supervisor.start();
    await supervisor.stop();
    await supervisor.unregister();

    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.slice(-4)).toEqual([
      `/Create /TN ${SCHEDULER_NAME} /XML ${definition} /F`,
      `/Run /TN ${SCHEDULER_NAME}`,
      `/End /TN ${SCHEDULER_NAME}`,
      `/Delete /TN ${SCHEDULER_NAME} /F`,
    ]);
    expect(calls.filter(call => call === `/Query /TN ${SCHEDULER_NAME} /XML`)).toHaveLength(13);
    expect(calls.join('\n')).not.toContain(`${SCHEDULER_NAME}-foreign`);
  });
});

describe('thin operator wrapper contracts', () => {
  it('keeps the launchd wrapper as an argv-preserving delegation only', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'mai-brain-web-launchd.sh'), 'utf8');
    expect(source).toContain('exec node "$ROOT/build/entry.js" dashboard persist "$@"');
    expect(source).not.toContain('launchctl');
  });

  it('allows Status without CheckoutRoot and passes no synthetic checkout argument', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'install-dashboard.ps1'), 'utf8');
    expect(source).toContain('[string]$CheckoutRoot');
    expect(source).not.toMatch(/\[Parameter\(Mandatory\)\]\s*\r?\n\s*\[string\]\$CheckoutRoot/u);
    expect(source).toContain("if ([string]::IsNullOrWhiteSpace($CheckoutRoot)) { $ScriptCheckoutRoot }");
    expect(source).toContain("if (-not [string]::IsNullOrWhiteSpace($CheckoutRoot)) {");
  });

  it('rejects Install without CheckoutRoot before Node or scheduler invocation', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'windows', 'install-dashboard.ps1'), 'utf8');
    const guard = source.indexOf("if ($Action -eq 'Install' -and [string]::IsNullOrWhiteSpace($CheckoutRoot))");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(source.indexOf('Get-Command node.exe'));
    expect(guard).toBeLessThan(source.indexOf('& $Node @Arguments'));
    expect(source).not.toContain('schtasks');
  });
});
