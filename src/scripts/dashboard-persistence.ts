import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import {
  DASHBOARD_PRIVATE_ENV_KEYS,
  dashboardBuildIdentity,
  dashboardStatus,
  defaultDashboardIO,
  resolveHealthUrl,
} from './dashboard.js';
import {
  dashboardLogPath,
  ensurePrivateDirectory,
  maiStateRoot,
  requireOwnedRegularOrAbsent,
} from '../platform/paths.js';
import { defaultProcessOps } from '../platform/processes.js';

export type PersistenceAction = 'install' | 'status' | 'restart' | 'stop' | 'logs' | 'uninstall';

export const LAUNCHD_LABEL = 'com.mai.brain-web';
export const SCHEDULER_NAME = 'mai-mcp-dashboard';
const STOP_TIMEOUT_MS = 30_000;
const STOP_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;

export interface PersistencePaths {
  root: string;
  definition: string;
  environment: string;
  dashboardLog: string;
  supervisorOut: string;
  supervisorErr: string;
}

export interface PersistenceRenderInput {
  platform: NodeJS.Platform;
  environment: Readonly<NodeJS.ProcessEnv>;
  checkoutRoot: string;
  nodePath: string;
  paths: PersistencePaths;
  username: string;
}

export interface PersistenceRenderResult {
  definition: string;
  privateEnvironment: string;
  executable: string;
  args: string[];
  healthUrl: string;
}

export interface SupervisorState {
  installed: boolean;
  running: boolean;
  identityVerified: boolean;
  owner: string;
  runLevel: string;
  nextRun: string;
  lastResult: string;
  retryStatus: 'none' | 'pending' | 'exhausted' | 'stopped' | 'unknown';
}

export interface PersistenceSupervisor {
  inspect(expected: PersistenceRenderResult | null): Promise<SupervisorState>;
  register(definitionPath: string, expected: PersistenceRenderResult): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  unregister(): Promise<void>;
}

export interface PersistenceDependencies {
  nodePath: string;
  username: string;
  supervisor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PersistenceSupervisor;
  status(environment: NodeJS.ProcessEnv): Promise<{ ok: boolean; text: string }>;
  listener(port: number): Promise<string | null>;
  sleep(milliseconds: number): Promise<void>;
  publish(source: string, target: string, ordinal: 1 | 2): void;
}

function safeValue(name: string, value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} contains a control character`);
  return value;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function unxml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

function xmlElement(source: string, tag: string): string | null {
  const matches = [...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gu'))];
  return matches.length === 1 ? unxml(matches[0][1].trim()) : null;
}

function launchdValue(lines: readonly string[], key: string): string | null {
  const prefix = `${key} = `;
  const matches = lines.filter(line => line.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
}

function launchdArguments(lines: readonly string[]): string[] | null {
  const starts = lines.flatMap((line, index) => line === 'arguments = {' ? [index] : []);
  if (starts.length !== 1) return null;
  const end = lines.indexOf('}', starts[0] + 1);
  if (end < 0) return null;
  return lines.slice(starts[0] + 1, end);
}

function launchdIdentityMatches(
  source: string,
  target: string,
  expected: PersistenceRenderResult,
  checkoutRoot: string,
): boolean {
  const lines = source.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const targetLines = lines.filter(line => line === `${target} = {`);
  const args = launchdArguments(lines);
  return targetLines.length === 1
    && launchdValue(lines, 'program') === expected.executable
    && launchdValue(lines, 'working directory') === checkoutRoot
    && args !== null
    && args.length === expected.args.length + 1
    && args.every((value, index) => value === [expected.executable, ...expected.args][index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function windowsArgument(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes += 1; continue; }
    if (character === '"') quoted += `${'\\'.repeat(slashes * 2 + 1)}"`;
    else quoted += `${'\\'.repeat(slashes)}${character}`;
    slashes = 0;
  }
  return `${quoted}${'\\'.repeat(slashes * 2)}"`;
}

function pathFlavor(platform: NodeJS.Platform, value: string): typeof path.posix {
  return platform === 'win32' && (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'))
    ? path.win32 : path.posix;
}

function absolute(platform: NodeJS.Platform, label: string, value: string): string {
  safeValue(label, value);
  const paths = pathFlavor(platform, value);
  if (!paths.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return paths.normalize(value);
}

function configuredEnvironment(checkoutRoot: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let fileEnvironment: NodeJS.ProcessEnv = {};
  const dotenvPath = path.join(checkoutRoot, '.env');
  try { fileEnvironment = parse(fs.readFileSync(dotenvPath)); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const selected: NodeJS.ProcessEnv = {};
  for (const key of DASHBOARD_PRIVATE_ENV_KEYS) {
    const value = Object.hasOwn(inherited, key) ? inherited[key] : fileEnvironment[key];
    if (value !== undefined && value !== '') selected[key] = safeValue(key, value);
  }
  return selected;
}

function privateEnvironmentText(environment: Readonly<NodeJS.ProcessEnv>): string {
  return DASHBOARD_PRIVATE_ENV_KEYS.flatMap(key => {
    const value = environment[key];
    return value === undefined || value === '' ? [] : [`${key}=${safeValue(key, value)}`];
  }).join('\n') + '\n';
}

export function renderPersistence(input: PersistenceRenderInput): PersistenceRenderResult {
  if (input.platform !== 'darwin' && input.platform !== 'win32') {
    throw new Error('dashboard persistence is supported only on macOS and Windows');
  }
  const checkoutRoot = absolute(input.platform, 'checkout root', input.checkoutRoot);
  const nodePath = absolute(input.platform, 'node executable', input.nodePath);
  const envFile = absolute(input.platform, 'private environment file', input.paths.environment);
  const entry = pathFlavor(input.platform, checkoutRoot).join(checkoutRoot, 'build', 'entry.js');
  const args = [entry, 'dashboard', 'run', '--env-file', envFile];
  const bind = input.environment.MAI_BRAIN_WEB_BIND ?? '127.0.0.1';
  const port = Number(input.environment.MAI_BRAIN_WEB_PORT ?? 6601);
  const healthUrl = resolveHealthUrl(bind, port, input.environment.MAI_BRAIN_WEB_URL || undefined);
  const privateEnvironment = privateEnvironmentText({ ...input.environment, MAI_BRAIN_WEB_URL: healthUrl });
  if (input.platform === 'darwin') {
    const definition = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCHD_LABEL}</string>
<key>ProgramArguments</key><array>${[nodePath, ...args].map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(checkoutRoot)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(input.paths.supervisorOut)}</string>
<key>StandardErrorPath</key><string>${xml(input.paths.supervisorErr)}</string>
</dict></plist>\n`;
    return { definition, privateEnvironment, executable: nodePath, args, healthUrl };
  }
  const argumentText = args.map(windowsArgument).join(' ');
  const definition = `<?xml version="1.0" encoding="UTF-8"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.4">
<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${xml(input.username)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure><Enabled>true</Enabled></Settings>
<Actions Context="Author"><Exec><Command>${xml(nodePath)}</Command><Arguments>${xml(argumentText)}</Arguments><WorkingDirectory>${xml(checkoutRoot)}</WorkingDirectory></Exec></Actions>
</Task>\n`;
  return { definition, privateEnvironment, executable: nodePath, args, healthUrl };
}

function persistencePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PersistencePaths {
  const root = path.join(maiStateRoot(env), 'dashboard-persistence');
  const home = env.HOME ?? os.homedir();
  const definition = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    : path.join(root, `${SCHEDULER_NAME}.xml`);
  return {
    root,
    definition,
    environment: path.join(root, 'service.env'),
    dashboardLog: dashboardLogPath(env),
    supervisorOut: path.join(root, 'supervisor.out.log'),
    supervisorErr: path.join(root, 'supervisor.err.log'),
  };
}

function parsePrivateEnvironment(source: string): NodeJS.ProcessEnv {
  const allowed: ReadonlySet<string> = new Set(DASHBOARD_PRIVATE_ENV_KEYS);
  const result: NodeJS.ProcessEnv = {};
  for (const line of source.split(/\r?\n/u)) {
    if (line === '') continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(result, match[1])) {
      throw new Error('private dashboard environment is invalid');
    }
    result[match[1]] = match[2];
  }
  return result;
}

function readInstalled(paths: PersistencePaths): { definition: string; environment: string } | null {
  requireOwnedRegularOrAbsent(paths.definition, 'supervisor definition');
  requireOwnedRegularOrAbsent(paths.environment, 'private dashboard environment');
  const definitionExists = fs.existsSync(paths.definition);
  const environmentExists = fs.existsSync(paths.environment);
  if (definitionExists !== environmentExists) throw new Error('dashboard persistence has split installed state');
  if (!definitionExists) return null;
  if (process.platform !== 'win32' && (fs.statSync(paths.environment).mode & 0o777) !== 0o600) {
    throw new Error('private dashboard environment must have mode 600');
  }
  return {
    definition: fs.readFileSync(paths.definition, 'utf8'),
    environment: fs.readFileSync(paths.environment, 'utf8'),
  };
}

function baseEnvironment(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  privateEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG'];
  if (platform === 'win32') names.push('SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'COMSPEC');
  const base = Object.fromEntries(names.flatMap(name => env[name] === undefined ? [] : [[name, env[name]]]));
  return { ...base, ...privateEnvironment };
}

function tempPath(target: string, role: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${role}.${process.pid}.${randomUUID()}`);
}

function removeExact(target: string): void {
  try { fs.unlinkSync(target); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}

function installText(platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? `Installed ${LAUNCHD_LABEL}`
    : `Installed ${SCHEDULER_NAME} (restart interval PT1M, retry count 255)`;
}

function ownershipText(
  platform: NodeJS.Platform,
  state: SupervisorState,
  render: PersistenceRenderResult,
  currentBuild: string,
): string {
  const name = platform === 'darwin' ? LAUNCHD_LABEL : SCHEDULER_NAME;
  return [
    `Supervisor: ${name}`,
    `Supervisor loaded: ${state.installed ? 'yes' : 'no'}`,
    `Supervisor running: ${state.running ? 'yes' : 'no'}`,
    `Executable: ${render.executable}`,
    `Arguments: ${render.args.join(' ')}`,
    `Run as: ${state.owner}`,
    `Run level: ${state.runLevel}`,
    `Next run: ${state.nextRun}`,
    `Last result: ${state.lastResult}`,
    `Retry state: ${state.retryStatus}`,
    `Current build: ${currentBuild}`,
    `Dashboard URL: ${render.healthUrl}`,
  ].join('\n');
}

async function waitUntilStopped(
  env: NodeJS.ProcessEnv,
  dependencies: PersistenceDependencies,
): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  do {
    const status = await dependencies.status(env);
    if (!status.ok && status.text === 'Health: STOPPED') return true;
    if (Date.now() >= deadline) return false;
    await dependencies.sleep(STOP_POLL_MS);
  } while (true);
}

async function waitUntilHealthy(
  env: NodeJS.ProcessEnv,
  dependencies: PersistenceDependencies,
): Promise<{ ok: boolean; text: string }> {
  const attempts = Math.ceil(HEALTH_TIMEOUT_MS / HEALTH_POLL_MS);
  let status = await dependencies.status(env);
  for (let attempt = 0; !status.ok && attempt < attempts; attempt += 1) {
    await dependencies.sleep(HEALTH_POLL_MS);
    status = await dependencies.status(env);
  }
  return status;
}

export async function runPersistenceWithDependencies(
  action: PersistenceAction,
  ctx: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; checkoutRoot?: string },
  dependencies: PersistenceDependencies,
): Promise<{ ok: boolean; text: string }> {
  try {
    if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
      return { ok: false, text: 'dashboard persistence is supported only on macOS and Windows' };
    }
    const paths = persistencePaths(ctx.platform, ctx.env);
    const installed = readInstalled(paths);
    const supervisor = dependencies.supervisor(ctx.platform, ctx.env);
    if (!installed && action !== 'install') {
      const state = await supervisor.inspect(null);
      if (state.installed) return { ok: false, text: 'supervisor is loaded without its installed file pair' };
      if (action === 'uninstall') {
        return { ok: true, text: `Uninstalled ${ctx.platform === 'darwin' ? LAUNCHD_LABEL : SCHEDULER_NAME}; logs preserved` };
      }
      return { ok: false, text: 'dashboard persistence is not installed' };
    }
    const root = ctx.checkoutRoot ?? (() => {
      if (!installed) throw new Error('dashboard persistence is not installed');
      const marker = ctx.platform === 'win32' ? /<WorkingDirectory>([^<]+)<\/WorkingDirectory>/u : /<key>WorkingDirectory<\/key><string>([^<]+)<\/string>/u;
      const match = marker.exec(installed.definition);
      if (!match) throw new Error('installed supervisor definition is malformed');
      return match[1].replaceAll('&amp;', '&').replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    })();
    const pathsForPlatform = pathFlavor(ctx.platform, root);
    if (!pathsForPlatform.isAbsolute(root)) throw new Error('checkout root must be absolute');
    if (action === 'install' && (!ctx.checkoutRoot || !fs.statSync(root).isDirectory())) {
      throw new Error('install requires an absolute existing checkout root');
    }
    const selected = action === 'install'
      ? configuredEnvironment(root, ctx.env)
      : parsePrivateEnvironment(installed?.environment ?? '');
    const render = renderPersistence({
      platform: ctx.platform,
      environment: selected,
      checkoutRoot: root,
      nodePath: dependencies.nodePath,
      paths,
      username: dependencies.username,
    });
    const privateEnv = baseEnvironment(ctx.platform, ctx.env, parsePrivateEnvironment(
      action === 'install' ? render.privateEnvironment : installed?.environment ?? '',
    ));
    const supervisorState = await supervisor.inspect(render);
    if (!installed && supervisorState.installed) {
      return { ok: false, text: 'supervisor is loaded without its installed file pair' };
    }
    if (supervisorState.installed && !supervisorState.identityVerified) {
      return { ok: false, text: 'refusing foreign supervisor identity' };
    }

    if (action === 'status') {
      let currentBuild = 'unreadable';
      try {
        currentBuild = dashboardBuildIdentity(
          pathsForPlatform.join(root, 'build', 'web-server.js'),
          pathsForPlatform.join(root, 'build', 'build-info.json'),
        );
      } catch { /* health text below also reports the unreadable build */ }
      const ownership = ownershipText(ctx.platform, supervisorState, render, currentBuild);
      if (!supervisorState.installed) return { ok: false, text: `${ownership}\nHealth: SUPERVISOR STOPPED` };
      const health = await dependencies.status(privateEnv);
      const exhausted = supervisorState.retryStatus === 'exhausted'
        ? '\nRetry policy: exhausted; run persist restart or log in again' : '';
      return { ok: health.ok && supervisorState.retryStatus !== 'exhausted', text: `${ownership}\n${health.text}${exhausted}` };
    }
    if (action === 'logs') {
      const files = [paths.dashboardLog, paths.supervisorOut, paths.supervisorErr];
      const output: string[] = files.map(file => `Log: ${file}`);
      for (const file of files) {
        requireOwnedRegularOrAbsent(file, 'dashboard log');
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
        if (lines.at(-1) === '') lines.pop();
        output.push(lines.slice(-100).join('\n'));
      }
      return { ok: true, text: output.join('\n') };
    }
    if (action === 'restart') {
      if (!supervisorState.installed) await supervisor.register(paths.definition, render);
      if (ctx.platform === 'win32' && supervisorState.running) {
        await supervisor.stop();
        if (!await waitUntilStopped(privateEnv, dependencies)) {
          return { ok: false, text: 'dashboard remains alive after scheduled-task stop; restart refused' };
        }
      }
      await supervisor.start();
      const health = await waitUntilHealthy(privateEnv, dependencies);
      return { ok: health.ok, text: health.text };
    }
    if (action === 'stop' || action === 'uninstall') {
      if (supervisorState.installed && supervisorState.running) await supervisor.stop();
      if (!await waitUntilStopped(privateEnv, dependencies)) {
        return { ok: false, text: 'dashboard remains alive after supervisor stop; installed state preserved' };
      }
      if (action === 'stop') return { ok: true, text: 'dashboard persistence stopped; supervisor remains installed' };
      if (supervisorState.installed) await supervisor.unregister();
      removeExact(paths.definition);
      removeExact(paths.environment);
      return { ok: true, text: `Uninstalled ${ctx.platform === 'darwin' ? LAUNCHD_LABEL : SCHEDULER_NAME}; logs preserved` };
    }

    ensurePrivateDirectory(paths.root);
    ensurePrivateDirectory(path.dirname(paths.definition));
    ensurePrivateDirectory(path.dirname(paths.dashboardLog));
    const entryPath = pathsForPlatform.join(root, 'build', 'entry.js');
    if (!fs.statSync(entryPath).isFile()) throw new Error('build/entry.js is required before installing persistence');
    const port = Number(selected.MAI_BRAIN_WEB_PORT ?? 6601);
    if (!installed && await dependencies.listener(port)) {
      return { ok: false, text: 'untracked dashboard listener; stop it with the dashboard stop command before installing' };
    }
    const environmentCandidate = tempPath(paths.environment, 'candidate');
    const definitionCandidate = tempPath(paths.definition, 'candidate');
    const environmentBackup = tempPath(paths.environment, 'backup');
    const definitionBackup = tempPath(paths.definition, 'backup');
    let rollbackRequired = false;
    try {
      fs.writeFileSync(environmentCandidate, render.privateEnvironment, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(definitionCandidate, render.definition, { mode: 0o600, flag: 'wx' });
      if (installed) {
        fs.copyFileSync(paths.environment, environmentBackup, fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(paths.definition, definitionBackup, fs.constants.COPYFILE_EXCL);
      }
      if (supervisorState.installed && supervisorState.running) {
        await supervisor.stop();
        rollbackRequired = true;
      }
      dependencies.publish(environmentCandidate, paths.environment, 1);
      rollbackRequired = true;
      dependencies.publish(definitionCandidate, paths.definition, 2);
      await supervisor.register(paths.definition, render);
      await supervisor.start();
      const health = await waitUntilHealthy(privateEnv, dependencies);
      if (!health.ok) throw new Error(`installed dashboard did not become healthy: ${health.text}`);
      return { ok: true, text: `${installText(ctx.platform)}\n${health.text}` };
    } catch (primary) {
      if (!rollbackRequired) throw primary;
      let rollback: Error | null = null;
      try {
        try { await supervisor.stop(); } catch { /* registration may not have completed */ }
        try { await supervisor.unregister(); } catch { /* registration may not have completed */ }
        if (installed) {
          removeExact(paths.environment);
          removeExact(paths.definition);
          fs.renameSync(environmentBackup, paths.environment);
          fs.renameSync(definitionBackup, paths.definition);
          if (supervisorState.installed) {
            await supervisor.register(paths.definition, renderPersistence({
              platform: ctx.platform,
              environment: parsePrivateEnvironment(installed.environment),
              checkoutRoot: root,
              nodePath: dependencies.nodePath,
              paths,
              username: dependencies.username,
            }));
            if (supervisorState.running) {
              await supervisor.start();
              const priorHealth = await waitUntilHealthy(baseEnvironment(
                ctx.platform,
                ctx.env,
                parsePrivateEnvironment(installed.environment),
              ), dependencies);
              if (!priorHealth.ok) throw new Error(`restored supervisor did not become healthy: ${priorHealth.text}`);
            }
          }
        } else {
          removeExact(paths.environment);
          removeExact(paths.definition);
        }
      } catch (error) { rollback = error instanceof Error ? error : new Error(String(error)); }
      const primaryText = primary instanceof Error ? primary.message : String(primary);
      return rollback
        ? { ok: false, text: `persistence install failed: ${primaryText}; rollback failed: ${rollback.message}` }
        : { ok: false, text: `persistence install failed: ${primaryText}; prior pair restored` };
    } finally {
      for (const file of [environmentCandidate, definitionCandidate, environmentBackup, definitionBackup]) removeExact(file);
    }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

function managementEnvironment(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG'];
  if (platform === 'win32') names.push('SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT');
  return Object.fromEntries(names.flatMap(name => env[name] === undefined ? [] : [[name, env[name]]]));
}

function command(binary: string, args: string[], environment: NodeJS.ProcessEnv): { status: number; text: string } {
  const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, env: environment });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, text: `${result.stdout}${result.stderr}` };
}

export function createPersistenceSupervisor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PersistenceSupervisor {
  const commandEnvironment = managementEnvironment(platform, env);
  if (platform === 'darwin') {
    const binary = env.MAI_DASHBOARD_LAUNCHCTL ?? 'launchctl';
    const domain = `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}`;
    const target = `${domain}/${LAUNCHD_LABEL}`;
    return {
      async inspect(expected) {
        const result = command(binary, ['print', target], commandEnvironment);
        if (result.status === 113 && result.text.includes('Could not find service')) {
          return { installed: false, running: false, identityVerified: true, owner: os.userInfo().username,
            runLevel: 'Limited', nextRun: 'login', lastResult: 'not loaded', retryStatus: 'none' };
        }
        if (result.status !== 0) throw new Error('could not determine LaunchAgent state');
        const identityVerified = expected !== null
          && launchdIdentityMatches(result.text, target, expected, path.dirname(path.dirname(expected.args[0])));
        return { installed: true, running: true, identityVerified,
          owner: `${os.userInfo().username} (${domain})`, runLevel: 'User LaunchAgent',
          nextRun: 'automatic', lastResult: 'loaded', retryStatus: 'none' };
      },
      async register(definitionPath) {
        if (command(binary, ['bootstrap', domain, definitionPath], commandEnvironment).status !== 0) throw new Error('LaunchAgent bootstrap failed');
      },
      async start() { if (command(binary, ['kickstart', '-k', target], commandEnvironment).status !== 0) throw new Error('LaunchAgent restart failed'); },
      async stop() { if (command(binary, ['bootout', target], commandEnvironment).status !== 0) throw new Error('LaunchAgent stop failed'); },
      async unregister() { /* bootout is the exact-name removal operation for launchd */ },
    };
  }
  const binary = env.MAI_DASHBOARD_SCHTASKS ?? 'schtasks.exe';
  const powershell = env.MAI_DASHBOARD_POWERSHELL ?? 'powershell.exe';
  const task = SCHEDULER_NAME;
  return {
    async inspect(expected) {
      const result = command(binary, ['/Query', '/TN', task, '/XML'], commandEnvironment);
      if (result.status !== 0 && /cannot find|does not exist/iu.test(result.text)) {
        return { installed: false, running: false, identityVerified: true, owner: os.userInfo().username,
          runLevel: 'Limited', nextRun: 'next logon', lastResult: 'not registered', retryStatus: 'none' };
      }
      if (result.status !== 0) throw new Error('could not determine scheduled-task state');
      const fields = ['UserId', 'LogonType', 'RunLevel', 'Command', 'Arguments', 'WorkingDirectory', 'Interval', 'Count'];
      const definitionMatches = expected !== null
        && fields.every(field => xmlElement(result.text, field) !== null
          && xmlElement(result.text, field) === xmlElement(expected.definition, field));
      const query = "$t=Get-ScheduledTask -TaskPath '\\' -TaskName $args[0] -ErrorAction Stop;"
        + '$i=$t | Get-ScheduledTaskInfo -ErrorAction Stop;'
        + '@{TaskName=[string]$t.TaskName;TaskPath=[string]$t.TaskPath;State=[string]$t.State;'
        + 'UserId=[string]$t.Principal.UserId;RunLevel=[string]$t.Principal.RunLevel;'
        + 'LogonType=[string]$t.Principal.LogonType;'
        + "NextRunTime=if($i.NextRunTime -eq [datetime]::MinValue){$null}else{$i.NextRunTime.ToUniversalTime().ToString('o')};"
        + 'LastTaskResult=[long]$i.LastTaskResult}|ConvertTo-Json -Compress';
      const detail = command(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query, task], commandEnvironment);
      if (detail.status !== 0) throw new Error('could not determine scheduled-task status');
      let parsed: unknown;
      try { parsed = JSON.parse(detail.text); } catch { throw new Error('scheduled-task status was malformed'); }
      if (!isRecord(parsed) || parsed.TaskName !== task || parsed.TaskPath !== '\\'
          || typeof parsed.State !== 'string' || typeof parsed.UserId !== 'string'
          || typeof parsed.RunLevel !== 'string' || typeof parsed.LogonType !== 'string'
          || !(parsed.NextRunTime === null || typeof parsed.NextRunTime === 'string')
          || typeof parsed.LastTaskResult !== 'number' || !Number.isSafeInteger(parsed.LastTaskResult)) {
        throw new Error('scheduled-task status was malformed');
      }
      const expectedUser = expected === null ? null : xmlElement(expected.definition, 'UserId');
      const identityVerified = definitionMatches && parsed.UserId === expectedUser
        && parsed.RunLevel === 'Limited' && parsed.LogonType === 'Interactive';
      const nextRunTime = parsed.NextRunTime === null ? null : Date.parse(parsed.NextRunTime);
      const hasFutureRun = nextRunTime !== null && Number.isFinite(nextRunTime) && nextRunTime > Date.now();
      let retryStatus: SupervisorState['retryStatus'] = 'unknown';
      if (parsed.State === 'Running' || parsed.LastTaskResult === 0) retryStatus = 'none';
      else if (parsed.LastTaskResult === 0x41306) retryStatus = 'stopped';
      else if (parsed.State === 'Queued' || hasFutureRun) retryStatus = 'pending';
      else if (parsed.State === 'Ready' && parsed.NextRunTime === null) retryStatus = 'exhausted';
      return { installed: true, running: parsed.State === 'Running', identityVerified,
        owner: parsed.UserId, runLevel: parsed.RunLevel,
        nextRun: parsed.NextRunTime ?? 'none', lastResult: String(parsed.LastTaskResult), retryStatus };
    },
    async register(definitionPath) {
      if (command(binary, ['/Create', '/TN', task, '/XML', definitionPath, '/F'], commandEnvironment).status !== 0) throw new Error('scheduled-task registration failed');
    },
    async start() { if (command(binary, ['/Run', '/TN', task], commandEnvironment).status !== 0) throw new Error('scheduled-task restart failed'); },
    async stop() { if (command(binary, ['/End', '/TN', task], commandEnvironment).status !== 0) throw new Error('scheduled-task stop failed'); },
    async unregister() { if (command(binary, ['/Delete', '/TN', task, '/F'], commandEnvironment).status !== 0) throw new Error('scheduled-task removal failed'); },
  };
}

function defaultDependencies(env: NodeJS.ProcessEnv): PersistenceDependencies {
  return {
    nodePath: process.execPath,
    username: os.userInfo().username,
    supervisor: createPersistenceSupervisor,
    status: environment => dashboardStatus(defaultDashboardIO(environment)),
    listener: port => defaultProcessOps().describeTcpListener(port),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    publish(source, target) { fs.renameSync(source, target); },
  };
}

export async function runPersistence(
  action: PersistenceAction,
  ctx: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; checkoutRoot?: string },
): Promise<{ ok: boolean; text: string }> {
  return runPersistenceWithDependencies(action, ctx, defaultDependencies(ctx.env));
}
