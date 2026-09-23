import { createHash, randomUUID } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withStateLock as withPlatformStateLock } from '../platform/locks.js';
import {
  dashboardLockPath,
  dashboardLogPath,
  dashboardStatePath,
  ensurePrivateDirectory,
  openPrivateAppendLog,
  requireOwnedRegularOrAbsent,
  validateManagedPaths,
  writePrivateFileAtomic,
} from '../platform/paths.js';
import {
  defaultProcessOps,
  spawnAttached,
  spawnDetached,
  type ChildHandle,
  type ChildSpec,
  type ProcessOps,
} from '../platform/processes.js';

export const RESERVATION_TTL_MS = 60_000;
const START_TIMEOUT_MS = 8_000;
const HEALTH_TIMEOUT_MS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const DASHBOARD_SERVER_ENV_KEYS = [
  'MAI_BRAIN_ROOT', 'MAI_BRAIN_WEB_BIND', 'MAI_BRAIN_WEB_PORT', 'MAI_BRAIN_WEB_TOKEN',
  'MAI_CC_TIMEOUT_MS', 'MAI_CLAUDE_CODE_MODEL', 'MAI_CODEX_CLI_MODEL', 'MAI_CODEX_CLI_REASONING',
  'MAI_DB_URL', 'MAI_EMBEDDINGS', 'MAI_GRAPH_DB_URL', 'MAI_LINKED_PROJECTS', 'MAI_LLM_BASE_URL',
  'MAI_LLM_FALLBACK_PROVIDER', 'MAI_LLM_PROVIDER', 'MAI_LLM_SUMMARY', 'MAI_PLAN_AUTOADVANCE',
  'MAI_PRIME_STARTUP', 'MAI_PROJECT_ROOT', 'MAI_PROJECT_SLUG', 'MAI_SUMMARY_MODEL',
  'MAI_STATE_HOME', 'MAI_JEV_ENABLED', 'MAI_JEV_MODEL', 'MAI_TOKEN_RECEIPTS_DIR',
] as const;
export const DASHBOARD_CONTROLLER_ENV_KEYS = ['MAI_BRAIN_WEB_URL'] as const;
export const DASHBOARD_PROVIDER_ENV_KEYS = ['TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY'] as const;
export const DASHBOARD_PRIVATE_ENV_KEYS = [...new Set([
  ...DASHBOARD_SERVER_ENV_KEYS,
  ...DASHBOARD_CONTROLLER_ENV_KEYS,
  ...DASHBOARD_PROVIDER_ENV_KEYS,
])].sort();
export const DASHBOARD_PRESERVE_EMPTY_PROVIDER_ENV_KEYS:ReadonlySet<string>=new Set([
  ...DASHBOARD_PROVIDER_ENV_KEYS,'MAI_JEV_ENABLED','MAI_JEV_MODEL','MAI_EMBEDDINGS','MAI_LLM_SUMMARY',
  'MAI_LLM_PROVIDER','MAI_LLM_FALLBACK_PROVIDER','MAI_SUMMARY_MODEL','MAI_CLAUDE_CODE_MODEL','MAI_CODEX_CLI_MODEL','MAI_LLM_BASE_URL',
]);
const DASHBOARD_PRIVATE_ENV_KEY_SET: ReadonlySet<string> = new Set(DASHBOARD_PRIVATE_ENV_KEYS);

export interface DashboardReservation {
  schema: 1; phase: 'reserved'; launchId: string; buildSha: string; starterPid: number; reservedAt: string;
}
export interface DashboardLaunching {
  schema: 1; phase: 'launching'; launchId: string; buildSha: string; runnerPid: number;
  runnerBirthId: string; serverPid: number | null;
}
export interface DashboardRunning {
  schema: 1; phase: 'running'; pid: number; birthId: string; runnerPid: number; launchId: string;
  buildSha: string; url: string; startedAt: string;
}
export interface DashboardStopping {
  schema: 1; phase: 'stopping'; operationId: string; ownerPid: number; ownerBirthId: string;
  target: DashboardRunning;
}
export type DashboardState = DashboardReservation | DashboardLaunching | DashboardRunning | DashboardStopping;

export interface DashboardIO {
  env: NodeJS.ProcessEnv;
  now(): Date;
  randomId(): string;
  preparePaths(envFile?: string): void;
  currentBuildIdentity(): string;
  withStateLock<T>(fn: () => Promise<T>): Promise<T>;
  readState(): DashboardState | null;
  writeState(state: DashboardState): void;
  removeState(): void;
  readPrivateFile(file: string): string;
  openLog(): number;
  closeLog(fd: number): void;
  spawnAttached(spec: ChildSpec): ChildHandle;
  spawnDetached(spec: ChildSpec): number;
  processOps: ProcessOps;
  launcherHealth(url: string, token: string | undefined): Promise<unknown>;
  projectsHealth(url: string, token: string | undefined): Promise<boolean>;
}

export interface RunOptions { envFile?: string; launchId?: string; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}
function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }

export function validateHealthUrl(value: string): string {
  const message = 'MAI_BRAIN_WEB_URL must be an http(s) URL without credentials';
  if (/[\u0000-\u0020\u007f]/u.test(value)) throw new Error(message);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(message); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(message);
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(message);
  return parsed.toString().replace(/\/$/u, '');
}

export function resolveHealthUrl(bind: string, port: number, explicit?: string): string {
  if (explicit) return validateHealthUrl(explicit);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid dashboard port');
  if (['127.0.0.1', 'localhost', '0.0.0.0'].includes(bind)) return `http://127.0.0.1:${port}`;
  if (['::', '[::]', '::1', '[::1]'].includes(bind)) return `http://[::1]:${port}`;
  throw new Error('set MAI_BRAIN_WEB_URL when MAI_BRAIN_WEB_BIND is a specific non-loopback address');
}

export function dashboardBuildIdentity(
  serverPath: string,
  infoPath: string,
  readBytes: (file: string) => Uint8Array = file => readFileSync(file),
): string {
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const server = digest(readBytes(serverPath));
  let info: Uint8Array;
  try { info = readBytes(infoPath); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return server;
    throw error;
  }
  return `${server}:${digest(info)}`;
}

export function isDashboardBuildIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}(?::[0-9a-f]{64})?$/u.test(value);
}

function parseRunning(value: unknown): DashboardRunning | null {
  if (!isRecord(value) || !exactKeys(value, ['schema', 'phase', 'pid', 'birthId', 'runnerPid', 'launchId', 'buildSha', 'url', 'startedAt'])
      || value.schema !== 1 || value.phase !== 'running' || !isPid(value.pid) || !isPid(value.runnerPid)
      || typeof value.birthId !== 'string' || !value.birthId || !isUuid(value.launchId)
      || !isDashboardBuildIdentity(value.buildSha) || !isIso(value.startedAt) || typeof value.url !== 'string') return null;
  try { validateHealthUrl(value.url); } catch { return null; }
  return {
    schema: 1, phase: 'running', pid: value.pid, birthId: value.birthId, runnerPid: value.runnerPid,
    launchId: value.launchId, buildSha: value.buildSha, url: value.url, startedAt: value.startedAt,
  };
}

export function parseDashboardState(value: unknown): DashboardState | null {
  if (!isRecord(value) || value.schema !== 1) return null;
  if (value.phase === 'reserved') {
    if (!exactKeys(value, ['schema', 'phase', 'launchId', 'buildSha', 'starterPid', 'reservedAt'])
      || !isUuid(value.launchId) || !isDashboardBuildIdentity(value.buildSha) || !isPid(value.starterPid)
      || !isIso(value.reservedAt)) return null;
    return { schema: 1, phase: 'reserved', launchId: value.launchId, buildSha: value.buildSha,
      starterPid: value.starterPid, reservedAt: value.reservedAt };
  }
  if (value.phase === 'launching') {
    if (!exactKeys(value, ['schema', 'phase', 'launchId', 'buildSha', 'runnerPid', 'runnerBirthId', 'serverPid'])
      || !isUuid(value.launchId) || !isDashboardBuildIdentity(value.buildSha) || !isPid(value.runnerPid)
      || typeof value.runnerBirthId !== 'string' || value.runnerBirthId.length === 0
      || !(value.serverPid === null || isPid(value.serverPid))) return null;
    return { schema: 1, phase: 'launching', launchId: value.launchId, buildSha: value.buildSha,
      runnerPid: value.runnerPid, runnerBirthId: value.runnerBirthId, serverPid: value.serverPid };
  }
  if (value.phase === 'running') return parseRunning(value);
  if (value.phase === 'stopping') {
    const target = parseRunning(value.target);
    if (!exactKeys(value, ['schema', 'phase', 'operationId', 'ownerPid', 'ownerBirthId', 'target'])
      || !isUuid(value.operationId) || !isPid(value.ownerPid) || typeof value.ownerBirthId !== 'string'
      || value.ownerBirthId.length === 0 || !target) return null;
    return { schema: 1, phase: 'stopping', operationId: value.operationId, ownerPid: value.ownerPid,
      ownerBirthId: value.ownerBirthId, target };
  }
  return null;
}

function sameRunning(a: DashboardRunning, b: DashboardRunning): boolean {
  return a.schema === b.schema && a.phase === b.phase && a.pid === b.pid && a.birthId === b.birthId
    && a.runnerPid === b.runnerPid && a.launchId === b.launchId && a.buildSha === b.buildSha
    && a.url === b.url && a.startedAt === b.startedAt;
}
function sameLaunching(a: DashboardLaunching, b: DashboardLaunching): boolean {
  return a.schema === b.schema && a.phase === b.phase && a.launchId === b.launchId
    && a.buildSha === b.buildSha && a.runnerPid === b.runnerPid
    && a.runnerBirthId === b.runnerBirthId && a.serverPid === b.serverPid;
}
function sameStopping(a: DashboardStopping, b: DashboardStopping): boolean {
  return a.operationId === b.operationId && a.ownerPid === b.ownerPid
    && a.ownerBirthId === b.ownerBirthId && sameRunning(a.target, b.target);
}

async function proved(target: DashboardRunning, io: DashboardIO): Promise<boolean> {
  try {
    return io.processOps.isAlive(target.pid)
      && await io.processOps.processBirthId(target.pid) === target.birthId
      && await io.processOps.processLaunchId(target.pid) === target.launchId
      && await io.processOps.processBirthId(target.pid) === target.birthId;
  } catch { return false; }
}

export async function reserveStop(target: DashboardRunning, io: DashboardIO): Promise<DashboardStopping | null> {
  const ownerBirthId = await io.processOps.processBirthId(process.pid);
  if (ownerBirthId === null) return null;
  return io.withStateLock(async () => {
    const current = io.readState();
    if (current?.phase === 'stopping') {
      if (!sameRunning(current.target, target)) return null;
      if (io.processOps.isAlive(current.ownerPid)) {
        const birth = await io.processOps.processBirthId(current.ownerPid);
        if (birth === null || birth === current.ownerBirthId) return null;
      }
    } else if (current?.phase !== 'running' || !sameRunning(current, target)) return null;
    if (!await proved(target, io)) return null;
    const operation: DashboardStopping = {
      schema: 1, phase: 'stopping', operationId: io.randomId(), ownerPid: process.pid,
      ownerBirthId, target: { ...target },
    };
    io.writeState(operation);
    return operation;
  });
}

export async function authorizeStopping(operation: DashboardStopping, io: DashboardIO): Promise<boolean> {
  return io.withStateLock(async () => {
    const current = io.readState();
    return current?.phase === 'stopping' && sameStopping(current, operation) && await proved(operation.target, io);
  });
}

export interface StopResult { stopped: boolean; error: Error | null; }
export async function executeStop(
  operation: DashboardStopping,
  io: DashboardIO,
  deliver: (authorize: () => Promise<boolean>) => Promise<void>,
): Promise<StopResult> {
  let deliveryError: Error | null = null;
  try { await deliver(() => authorizeStopping(operation, io)); }
  catch (error) { deliveryError = error instanceof Error ? error : new Error(String(error)); }
  const stopped = await io.withStateLock(async () => {
    const current = io.readState();
    if (current?.phase !== 'stopping' || !sameStopping(current, operation)) return false;
    const alive = io.processOps.isAlive(operation.target.pid);
    const birth = alive ? await io.processOps.processBirthId(operation.target.pid) : null;
    if (!alive || (birth !== null && birth !== operation.target.birthId)) {
      io.removeState();
      return true;
    }
    io.writeState({ ...operation.target });
    return false;
  });
  return { stopped, error: deliveryError };
}

export function dashboardStatusBuild(
  io: Pick<DashboardIO, 'currentBuildIdentity'>,
  recordedBuild: string,
): { ok: boolean; text: string } {
  try {
    return io.currentBuildIdentity() === recordedBuild
      ? { ok: true, text: 'Health: OK' }
      : { ok: false, text: 'Health: STALE BUILD' };
  } catch {
    return { ok: false, text: 'Health: BUILD UNREADABLE' };
  }
}

function baseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG'];
  if (process.platform === 'win32') keys.push('SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'COMSPEC');
  return Object.fromEntries(keys.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
}

function parsePrivateEnvironment(source: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const raw of source.split(/\r?\n/u)) {
    if (!raw || raw.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(raw);
    if (!match || !DASHBOARD_PRIVATE_ENV_KEY_SET.has(match[1])) throw new Error('private dashboard environment contains an unsupported key');
    if (Object.hasOwn(result, match[1])) throw new Error('private dashboard environment contains a duplicate key');
    result[match[1]] = match[2];
  }
  return result;
}

function selectedEnvironment(options: RunOptions, io: DashboardIO): NodeJS.ProcessEnv {
  if (options.envFile) return { ...baseEnvironment(io.env), ...parsePrivateEnvironment(io.readPrivateFile(options.envFile)) };
  return { ...io.env };
}

function configuration(env: NodeJS.ProcessEnv): { bind: string; port: number; url: string; token: string | undefined } {
  const bind = env.MAI_BRAIN_WEB_BIND ?? '127.0.0.1';
  const port = Number(env.MAI_BRAIN_WEB_PORT ?? 6601);
  const url = resolveHealthUrl(bind, port, env.MAI_BRAIN_WEB_URL || undefined);
  return { bind, port, url, token: env.MAI_BRAIN_WEB_TOKEN || undefined };
}

function reservationExpired(state: DashboardReservation, io: DashboardIO): boolean {
  return io.now().getTime() - Date.parse(state.reservedAt) > RESERVATION_TTL_MS || !io.processOps.isAlive(state.starterPid);
}

async function healthy(snapshot: DashboardRunning, io: DashboardIO, token = io.env.MAI_BRAIN_WEB_TOKEN): Promise<boolean> {
  if (!await proved(snapshot, io)) return false;
  const launcher = await io.launcherHealth(snapshot.url, token);
  if (!isRecord(launcher) || launcher.ok !== true || launcher.pid !== snapshot.pid || launcher.launch_id !== snapshot.launchId) return false;
  if (!await io.projectsHealth(snapshot.url, token)) return false;
  return io.withStateLock(async () => {
    const current = io.readState();
    return current?.phase === 'running' && sameRunning(current, snapshot);
  });
}

async function identityDead(pid: number, birthId: string, io: DashboardIO): Promise<boolean> {
  if (!io.processOps.isAlive(pid)) return true;
  const actual = await io.processOps.processBirthId(pid);
  return actual !== null && actual !== birthId;
}

async function launchingCanBeCleared(snapshot: DashboardLaunching, io: DashboardIO): Promise<boolean> {
  if (!await identityDead(snapshot.runnerPid, snapshot.runnerBirthId, io)) return false;
  return snapshot.serverPid !== null && !io.processOps.isAlive(snapshot.serverPid);
}

async function stoppingTargetGone(snapshot: DashboardStopping, io: DashboardIO): Promise<boolean> {
  if (!io.processOps.isAlive(snapshot.target.pid)) return true;
  const birth = await io.processOps.processBirthId(snapshot.target.pid);
  return birth !== null && birth !== snapshot.target.birthId;
}

async function cleanRecoverablePhase(snapshot: DashboardState, io: DashboardIO): Promise<boolean> {
  if (snapshot.phase === 'launching' && !await launchingCanBeCleared(snapshot, io)) return false;
  if (snapshot.phase === 'stopping' && !await stoppingTargetGone(snapshot, io)) return false;
  if (snapshot.phase !== 'launching' && snapshot.phase !== 'stopping') return false;
  const current = io.readState();
  const same = snapshot.phase === 'launching'
    ? current?.phase === 'launching' && current.launchId === snapshot.launchId
      && current.runnerPid === snapshot.runnerPid && current.runnerBirthId === snapshot.runnerBirthId
      && current.serverPid === snapshot.serverPid && current.buildSha === snapshot.buildSha
    : current?.phase === 'stopping' && sameStopping(current, snapshot);
  if (!same) return false;
  io.removeState();
  return true;
}

function childExitCode(exit: Awaited<ReturnType<ChildHandle['wait']>>): number {
  if (exit.code !== null) return exit.code;
  return 128 + (exit.signal ? osConstants.signals[exit.signal] : 1);
}

function serverSpec(env: NodeJS.ProcessEnv, launchId: string, logFd: number, privateMode: boolean): ChildSpec {
  const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web-server.js');
  const argv = [process.execPath, serverPath, '--launch-id', launchId];
  if (privateMode) argv.push('--mai-private-environment');
  return { argv, env: { ...env, MAI_BRAIN_WEB_LAUNCH_ID: launchId }, cwd: path.resolve(path.dirname(serverPath), '..'), logFd };
}

export async function dashboardRun(options: RunOptions = {}, supplied?: DashboardIO): Promise<number> {
  const io = supplied ?? defaultDashboardIO();
  io.preparePaths(options.envFile);
  const buildSha = io.currentBuildIdentity();
  const env = selectedEnvironment(options, io);
  const { url, token } = configuration(env);
  type ManagedSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
  let forwardSignal: ((signal: ManagedSignal) => void) | null = null;
  let pendingSignal: ManagedSignal | null = null;
  const queueSignal = (signal: ManagedSignal) => {
    if (forwardSignal) forwardSignal(signal);
    else pendingSignal ??= signal;
  };
  const onInt = () => queueSignal('SIGINT');
  const onTerm = () => queueSignal('SIGTERM');
  const onHup = () => queueSignal('SIGHUP');
  const removeSignalHandlers = () => {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); process.off('SIGHUP', onHup);
  };
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm); process.on('SIGHUP', onHup);
  let launchId = options.launchId;
  type RunPreparation =
    | { ok: false; spawned?: undefined; message: string }
    | { ok: false; spawned: ChildHandle; launching: DashboardLaunching; error: Error }
    | { ok: true; handle: ChildHandle; running: DashboardRunning };
  interface SpawnRecovery { handle: ChildHandle; launching: DashboardLaunching; running: DashboardRunning | null; }
  let postLockSpawn: SpawnRecovery | null = null;
  let preHandleLaunching: DashboardLaunching | null = null;
  const spawnedAfterLockFailure = () => postLockSpawn;
  const cleanUnspawnedStateLocked = (snapshot: DashboardLaunching): void => {
    const current = io.readState();
    if (current?.phase === 'launching' && sameLaunching(current, snapshot)) io.removeState();
  };
  const recoveryOwnsChild = async (recovery: SpawnRecovery): Promise<boolean> => io.withStateLock(async () => {
    const current = io.readState();
    const owned = recovery.running
      ? current?.phase === 'running' && sameRunning(current, recovery.running)
      : current?.phase === 'launching' && current.launchId === recovery.launching.launchId
        && current.runnerPid === recovery.launching.runnerPid
        && (current.serverPid === null || current.serverPid === recovery.handle.pid);
    if (!owned || !io.processOps.isAlive(recovery.handle.pid)) return false;
    const firstBirth = await io.processOps.processBirthId(recovery.handle.pid);
    const childLaunchId = await io.processOps.processLaunchId(recovery.handle.pid);
    const secondBirth = await io.processOps.processBirthId(recovery.handle.pid);
    return firstBirth !== null && firstBirth === secondBirth && childLaunchId === recovery.launching.launchId;
  });
  const stopSpawnedAfterFailure = async (recovery: SpawnRecovery): Promise<void> => {
    const exitPromise = recovery.handle.wait();
    const signal = pendingSignal ?? 'SIGTERM';
    const first = await recovery.handle.signal(signal, () => recoveryOwnsChild(recovery));
    let deliveryError: Error | null = first.kind === 'failed' ? first.error : null;
    if (first.kind !== 'failed' && io.processOps.isAlive(recovery.handle.pid)) {
      await delay(3_000);
      if (io.processOps.isAlive(recovery.handle.pid)) {
        const forced = await recovery.handle.signal('SIGKILL', () => recoveryOwnsChild(recovery));
        if (forced.kind === 'failed') deliveryError = forced.error;
      }
    }
    await exitPromise;
    if (deliveryError) throw deliveryError;
  };
  const cleanSpawnedState = async (recovery: SpawnRecovery): Promise<void> => {
    await io.withStateLock(async () => {
      const current = io.readState();
      if (recovery.running && current?.phase === 'running' && sameRunning(current, recovery.running)
          && !io.processOps.isAlive(recovery.handle.pid)) io.removeState();
      else if (!recovery.running && current?.phase === 'launching' && current.launchId === recovery.launching.launchId
          && current.runnerPid === recovery.launching.runnerPid && !io.processOps.isAlive(recovery.handle.pid)) io.removeState();
    });
  };
  let prepared: RunPreparation;
  try { prepared = await io.withStateLock<RunPreparation>(async () => {
    const current = io.readState();
    if (launchId) {
      if (current?.phase === 'reserved' && reservationExpired(current, io)) {
        io.removeState();
        return { ok: false, message: `no reservation for launch ${launchId}` };
      }
      if (current?.phase !== 'reserved' || current.launchId !== launchId) {
        return { ok: false, message: `no reservation for launch ${launchId}` };
      }
      if (current.buildSha !== buildSha) return { ok: false, message: `no reservation for launch ${launchId}` };
    } else {
      if (current?.phase === 'reserved' && reservationExpired(current, io)) io.removeState();
      else if (current?.phase === 'running' && !io.processOps.isAlive(current.pid)) io.removeState();
      else if ((current?.phase === 'launching' || current?.phase === 'stopping') && await cleanRecoverablePhase(current, io)) { /* recovered */ }
      else if (current !== null) {
        if (current.phase === 'reserved') return { ok: false, message: 'start in progress' };
        const runnerPid = current.phase === 'running' || current.phase === 'launching'
          ? current.runnerPid : current.target.runnerPid;
        return { ok: false, message: `dashboard already running under runner ${runnerPid}` };
      }
      launchId = io.randomId();
    }
    const runnerBirthId = await io.processOps.processBirthId(process.pid);
    if (runnerBirthId === null || !launchId) return { ok: false, message: 'dashboard runner identity could not be proved' };
    const launching: DashboardLaunching = {
      schema: 1, phase: 'launching', launchId, buildSha, runnerPid: process.pid, runnerBirthId, serverPid: null,
    };
    preHandleLaunching = launching;
    let logFd: number;
    try {
      io.writeState(launching);
      logFd = io.openLog();
    } catch (error) {
      try {
        cleanUnspawnedStateLocked(launching);
        preHandleLaunching = null;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'dashboard preparation and no-child cleanup failed');
      }
      throw error;
    }
    let handle: ChildHandle;
    try { handle = io.spawnAttached(serverSpec(env, launchId, logFd, Boolean(options.envFile))); }
    catch (error) {
      const cleanupErrors: unknown[] = [];
      try { io.closeLog(logFd); } catch (caught) { cleanupErrors.push(caught); }
      try {
        cleanUnspawnedStateLocked(launching);
        preHandleLaunching = null;
      } catch (caught) { cleanupErrors.push(caught); }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'dashboard spawn and no-child cleanup failed');
      }
      throw error;
    }
    postLockSpawn = { handle, launching, running: null };
    preHandleLaunching = null;
    try { io.closeLog(logFd); }
    catch (error) {
      return { ok: false, spawned: handle, launching, error: error instanceof Error ? error : new Error(String(error)) };
    }
    try {
      const published = { ...launching, serverPid: handle.pid };
      io.writeState(published);
      const birthId = await io.processOps.processBirthId(handle.pid);
      const childLaunchId = await io.processOps.processLaunchId(handle.pid);
      if (birthId === null || childLaunchId !== launchId) throw new Error('dashboard child identity could not be proved');
      const running: DashboardRunning = {
        schema: 1, phase: 'running', pid: handle.pid, birthId, runnerPid: process.pid, launchId,
        buildSha, url, startedAt: io.now().toISOString(),
      };
      io.writeState(running);
      postLockSpawn = { handle, launching, running };
      return { ok: true, handle, running };
    } catch (error) {
      return { ok: false, spawned: handle, launching, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }); } catch (error) {
    const recoveryErrors: unknown[] = [];
    try {
      const recovery = spawnedAfterLockFailure();
      if (recovery) {
        try { await stopSpawnedAfterFailure(recovery); } catch (caught) { recoveryErrors.push(caught); }
        try { await cleanSpawnedState(recovery); } catch (caught) { recoveryErrors.push(caught); }
      } else {
        const stranded = preHandleLaunching;
        if (stranded) {
          try { await io.withStateLock(async () => cleanUnspawnedStateLocked(stranded)); }
          catch (caught) { recoveryErrors.push(caught); }
        }
      }
    } finally { removeSignalHandlers(); }
    if (recoveryErrors.length > 0) throw new AggregateError([error, ...recoveryErrors], 'dashboard preparation and recovery failed');
    throw error;
  }
  if (!prepared.ok) {
    if (!prepared.spawned) {
      removeSignalHandlers();
      process.stderr.write(`error: ${prepared.message}\n`);
      return 3;
    }
    const recovery: SpawnRecovery = { handle: prepared.spawned, launching: prepared.launching, running: null };
    const recoveryErrors: unknown[] = [];
    try { await stopSpawnedAfterFailure(recovery); } catch (error) { recoveryErrors.push(error); }
    try { await cleanSpawnedState(recovery); } catch (error) { recoveryErrors.push(error); }
    removeSignalHandlers();
    if (recoveryErrors.length > 0) throw new AggregateError([prepared.error, ...recoveryErrors], 'dashboard preparation and recovery failed');
    throw prepared.error;
  }

  const child = prepared.handle;
  const target = prepared.running;
  const exitPromise = child.wait();
  let shutdown: Promise<void> | null = null;
  const requestShutdown = (signal: ManagedSignal) => {
    if (shutdown) return;
    const attempt = async () => {
      const operation = await reserveStop(target, io);
      if (!operation) throw new Error('dashboard shutdown identity could not be reserved');
      const result = await executeStop(operation, io, async authorize => {
        const first = await child.signal(signal, authorize);
        if (first.kind === 'failed') throw first.error;
        if (!io.processOps.isAlive(target.pid)) return;
        await delay(3_000);
        if (!io.processOps.isAlive(target.pid)) return;
        const forced = await child.signal('SIGKILL', authorize);
        if (forced.kind === 'failed') throw forced.error;
      });
      if (result.error || !result.stopped) throw result.error ?? new Error('dashboard child remains alive');
    };
    shutdown = attempt().catch(() => {
      process.stderr.write('error: dashboard shutdown failed; state preserved\n');
    }).finally(() => { shutdown = null; });
  };
  forwardSignal = requestShutdown;
  if (pendingSignal) requestShutdown(pendingSignal);
  const readinessDeadline = performance.now() + START_TIMEOUT_MS;
  for (;;) {
    const raced = await Promise.race([
      exitPromise.then(exit => ({ kind: 'exit', exit } as const)),
      healthy(target, io, token).then(
        ok => ({ kind: 'health', ok } as const),
        () => ({ kind: 'health', ok: false } as const),
      ),
    ]);
    if (raced.kind === 'exit') {
      const status = childExitCode(raced.exit);
      try {
        await shutdown;
        await io.withStateLock(async () => {
          const current = io.readState();
          if (current?.phase === 'running' && sameRunning(current, target) && raced.exit.signal === null) io.removeState();
        });
      } catch {
        process.stderr.write('error: dashboard exit cleanup failed; child status preserved\n');
      } finally { removeSignalHandlers(); }
      return status;
    }
    if (raced.ok) break;
    if (performance.now() >= readinessDeadline) {
      try {
        const operation = await reserveStop(target, io);
        if (operation) await executeStop(operation, io, authorize => io.processOps.terminateTree(target.pid, authorize));
      } catch {
        process.stderr.write('error: dashboard readiness cleanup failed; state preserved\n');
      }
      const exit = await exitPromise;
      await shutdown;
      removeSignalHandlers();
      return childExitCode(exit);
    }
    await delay(250);
  }

  let exit;
  try { exit = await exitPromise; await shutdown; }
  finally { removeSignalHandlers(); }
  const status = childExitCode(exit);
  try {
    await io.withStateLock(async () => {
      const current = io.readState();
      if (current?.phase === 'running' && sameRunning(current, target) && exit.signal === null) io.removeState();
      else if (current?.phase === 'launching' && current.runnerPid === process.pid && current.launchId === target.launchId) io.removeState();
    });
  } catch {
    process.stderr.write('error: dashboard exit cleanup failed; child status preserved\n');
  }
  return status;
}

export async function dashboardStart(supplied?: DashboardIO): Promise<string> {
  const io = supplied ?? defaultDashboardIO();
  io.preparePaths();
  const buildSha = io.currentBuildIdentity();
  type StartDecision =
    | { kind: 'message'; text: string }
    | { kind: 'error'; text: string }
    | { kind: 'existing'; snapshot: DashboardRunning }
    | { kind: 'reserved'; reservation: DashboardReservation };
  const decision = await io.withStateLock<StartDecision>(async () => {
    const current = io.readState();
    if (current?.phase === 'reserved') {
      if (!reservationExpired(current, io)) return { kind: 'message', text: `start already in progress (launch ${current.launchId}, since ${current.reservedAt})` };
      io.removeState();
    } else if (current?.phase === 'running') {
      if (io.processOps.isAlive(current.pid)) return { kind: 'existing', snapshot: current };
      io.removeState();
    } else if (current?.phase === 'launching' || current?.phase === 'stopping') {
      if (!await cleanRecoverablePhase(current, io)) {
        return { kind: 'error', text: current.phase === 'launching' ? 'incomplete launch; ownership cannot be proved' : 'stop in progress' };
      }
    }
    const launchId = io.randomId();
    const reservation: DashboardReservation = { schema: 1, phase: 'reserved', launchId, buildSha, starterPid: process.pid, reservedAt: io.now().toISOString() };
    io.writeState(reservation);
    return { kind: 'reserved', reservation };
  });
  if (decision.kind === 'message') return decision.text;
  if (decision.kind === 'error') throw new Error(decision.text);
  if (decision.kind === 'existing') {
    const snapshot = decision.snapshot;
    if (await healthy(snapshot, io) && snapshot.buildSha === buildSha) {
      return `mai-brain-web already running, pid=${snapshot.pid} (current build)\n  URL: ${snapshot.url}`;
    }
    const operation = await reserveStop(snapshot, io);
    if (!operation) throw new Error('managed dashboard is unhealthy or stale; process identity could not be proved and state was preserved');
    const stopped = await executeStop(operation, io, authorize => io.processOps.terminateTree(snapshot.pid, authorize));
    if (stopped.error || !stopped.stopped) {
      throw new Error('managed dashboard is unhealthy or stale; verified stop failed and state was preserved');
    }
    throw new Error('managed dashboard was unhealthy or stale; verified server stopped, retry start');
  }
  const reserved = decision.reservation;
  const entryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'entry.js');
  let logFd: number | null = null;
  try {
    logFd = io.openLog();
    io.spawnDetached({
      argv: [process.execPath, entryPath, 'dashboard', 'run', '--launch-id', reserved.launchId],
      env: { ...io.env }, cwd: path.resolve(path.dirname(entryPath), '..'), logFd,
    });
  } catch (error) {
    await io.withStateLock(async () => {
      const current = io.readState();
      if (current?.phase === 'reserved' && current.launchId === reserved.launchId
          && current.buildSha === reserved.buildSha && current.starterPid === reserved.starterPid
          && current.reservedAt === reserved.reservedAt) io.removeState();
    });
    throw error;
  } finally {
    if (logFd !== null) io.closeLog(logFd);
  }
  const deadline = io.now().getTime() + START_TIMEOUT_MS;
  while (io.now().getTime() < deadline) {
    const snapshot = await io.withStateLock(async () => io.readState());
    if (snapshot?.phase === 'running' && snapshot.launchId === reserved.launchId
        && await healthy(snapshot, io) && snapshot.buildSha === buildSha) {
      return `mai-brain-web started, pid=${snapshot.pid}\n  Build: ${snapshot.buildSha.slice(0, 12)}\n  URL: ${snapshot.url}`;
    }
    await delay(250);
  }
  type TimeoutDecision =
    | { kind: 'canceled' }
    | { kind: 'running'; snapshot: DashboardRunning }
    | { kind: 'phase'; text: string };
  const timeout = await io.withStateLock<TimeoutDecision>(async () => {
    const current = io.readState();
    if (current?.phase === 'reserved' && current.launchId === reserved.launchId) {
      io.removeState();
      return { kind: 'canceled' };
    }
    if (current?.phase === 'running' && current.launchId === reserved.launchId) return { kind: 'running', snapshot: current };
    if (current?.phase === 'launching' && current.launchId === reserved.launchId) {
      return { kind: 'phase', text: 'dashboard launch timed out in launching phase; state preserved' };
    }
    return { kind: 'phase', text: 'dashboard launch state was replaced; state preserved' };
  });
  if (timeout.kind === 'running') {
    const operation = await reserveStop(timeout.snapshot, io);
    if (operation) {
      const result = await executeStop(operation, io, authorize => io.processOps.terminateTree(timeout.snapshot.pid, authorize));
      if (!result.stopped) throw new Error('dashboard launch timed out and verified server could not be stopped; state preserved');
    } else {
      throw new Error('dashboard launch timed out and server identity could not be proved; state preserved');
    }
  }
  if (timeout.kind === 'phase') throw new Error(timeout.text);
  throw new Error('dashboard did not become healthy within 8s');
}

export async function dashboardStatus(supplied?: DashboardIO): Promise<{ ok: boolean; text: string }> {
  const io = supplied ?? defaultDashboardIO();
  io.preparePaths();
  const snapshot = await io.withStateLock(async () => {
    const current = io.readState();
    if ((current?.phase === 'launching' || current?.phase === 'stopping') && await cleanRecoverablePhase(current, io)) return null;
    return current;
  });
  if (snapshot === null) return { ok: false, text: 'Health: STOPPED' };
  if (snapshot.phase === 'reserved') {
    if (reservationExpired(snapshot, io)) {
      await io.withStateLock(async () => {
        const current = io.readState();
        if (current?.phase === 'reserved' && current.launchId === snapshot.launchId) io.removeState();
      });
      return { ok: false, text: 'Health: STOPPED' };
    }
    const seconds = Math.max(0, Math.floor((io.now().getTime() - Date.parse(snapshot.reservedAt)) / 1_000));
    return { ok: false, text: `starting (launch ${snapshot.launchId}, reserved ${seconds}s ago by pid ${snapshot.starterPid})` };
  }
  if (snapshot.phase === 'launching') return { ok: false, text: 'Health: LAUNCHING' };
  if (snapshot.phase === 'stopping') return { ok: false, text: 'Health: STOPPING' };
  if (!io.processOps.isAlive(snapshot.pid)) {
    await io.withStateLock(async () => {
      const current = io.readState();
      if (current?.phase === 'running' && sameRunning(current, snapshot)) io.removeState();
    });
    return { ok: false, text: 'Health: STOPPED' };
  }
  if (!await healthy(snapshot, io)) return { ok: false, text: 'Health: UNHEALTHY' };
  const build = dashboardStatusBuild(io, snapshot.buildSha);
  if (!build.ok) return build;
  const stillCurrent = await io.withStateLock(async () => {
    const current = io.readState();
    return current?.phase === 'running' && sameRunning(current, snapshot);
  });
  return stillCurrent ? build : { ok: false, text: 'Health: STATE CHANGED' };
}

export async function dashboardStop(supplied?: DashboardIO): Promise<string> {
  const io = supplied ?? defaultDashboardIO();
  io.preparePaths();
  const snapshot = await io.withStateLock(async () => {
    const current = io.readState();
    if ((current?.phase === 'launching' || current?.phase === 'stopping') && await cleanRecoverablePhase(current, io)) return null;
    return current;
  });
  if (snapshot === null) return 'mai-brain-web is not running';
  if (snapshot.phase === 'reserved') {
    if (reservationExpired(snapshot, io)) {
      await io.withStateLock(async () => {
        const current = io.readState();
        if (current?.phase === 'reserved' && current.launchId === snapshot.launchId) io.removeState();
      });
      return 'mai-brain-web is not running';
    }
    throw new Error('start in progress');
  }
  if (snapshot.phase === 'launching') throw new Error('incomplete launch; ownership cannot be proved');
  if (snapshot.phase === 'stopping') {
    const takeover = await reserveStop(snapshot.target, io);
    if (!takeover) throw new Error('stop in progress');
    const result = await executeStop(takeover, io, authorize => io.processOps.terminateTree(snapshot.target.pid, authorize));
    if (!result.stopped) throw new Error('dashboard stop failed; state preserved');
    return `mai-brain-web stopped, pid=${snapshot.target.pid}`;
  }
  if (!io.processOps.isAlive(snapshot.pid)) {
    await io.withStateLock(async () => {
      const current = io.readState();
      if (current?.phase === 'running' && sameRunning(current, snapshot)) io.removeState();
    });
    return 'mai-brain-web is not running';
  }
  const operation = await reserveStop(snapshot, io);
  if (!operation) throw new Error('dashboard process identity is foreign or stale; state preserved');
  const result = await executeStop(operation, io, authorize => io.processOps.terminateTree(snapshot.pid, authorize));
  if (!result.stopped) throw new Error(result.error ? 'dashboard stop failed; state preserved' : 'dashboard remains alive; state preserved');
  return `mai-brain-web stopped, pid=${snapshot.pid}`;
}

async function fetchJson(url: string, route: string, token: string | undefined): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}${route}`, {
      headers: token ? { 'x-mai-brain-token': token } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('dashboard health request failed');
    return await response.json();
  } finally { clearTimeout(timer); }
}

export function defaultDashboardIO(env: NodeJS.ProcessEnv = process.env): DashboardIO {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.resolve(moduleDir, '..', 'web-server.js');
  const infoPath = path.resolve(moduleDir, '..', 'build-info.json');
  const statePath = dashboardStatePath(env);
  const lockPath = dashboardLockPath(env);
  const logPath = dashboardLogPath(env);
  const processOps = defaultProcessOps();
  return {
    env,
    now: () => new Date(),
    randomId: randomUUID,
    preparePaths(envFile) {
      ensurePrivateDirectory(path.dirname(statePath));
      const targets = [statePath, lockPath, `${lockPath}-journal`, `${lockPath}-wal`, `${lockPath}-shm`, logPath];
      if (envFile) targets.push(envFile);
      validateManagedPaths(targets);
    },
    currentBuildIdentity: () => dashboardBuildIdentity(serverPath, infoPath),
    withStateLock: fn => withPlatformStateLock(lockPath, 10_000, fn),
    readState() {
      requireOwnedRegularOrAbsent(statePath, 'dashboard state');
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const state = parseDashboardState(parsed);
        if (state === null) throw new Error('dashboard state is malformed');
        return state;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    writeState: state => writePrivateFileAtomic(statePath, `${JSON.stringify(state)}\n`),
    removeState() {
      requireOwnedRegularOrAbsent(statePath, 'dashboard state');
      try { fs.unlinkSync(statePath); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    },
    readPrivateFile(file) {
      requireOwnedRegularOrAbsent(file, 'private dashboard environment');
      return fs.readFileSync(file, 'utf8');
    },
    openLog: () => openPrivateAppendLog(logPath),
    closeLog: fd => fs.closeSync(fd),
    spawnAttached,
    spawnDetached,
    processOps,
    launcherHealth: (url, token) => fetchJson(url, '/api/launcher-health', token),
    projectsHealth: async (url, token) => {
      try { await fetchJson(url, '/api/projects', token); return true; } catch { return false; }
    },
  };
}
