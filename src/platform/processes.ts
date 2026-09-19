import { setTimeout as delay } from 'node:timers/promises';
import { findExecutable, spawnArgv, spawnArgvSync } from './commands.js';

export interface ProcessOps {
  platform: NodeJS.Platform;
  isAlive(pid: number): boolean;
  terminateTree(pid: number, authorize?: () => Promise<boolean>): Promise<void>;
  describeTcpListener(port: number): Promise<string | null>;
  ancestorPids(pid: number): Promise<readonly number[] | null>;
  processBirthId(pid: number): Promise<string | null>;
  processLaunchId(pid: number): Promise<string | null>;
}

export interface PosixTreeRow { pid: number; parentPid: number; birthId: string; }
export interface PosixTreeOps {
  selfPid: number;
  snapshot(): Promise<readonly PosixTreeRow[]>;
  birthId(pid: number): Promise<string | null>;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ChildExit { code: number | null; signal: NodeJS.Signals | null; }
export type SignalOutcome =
  | { kind: 'signalled' }
  | { kind: 'gone' }
  | { kind: 'failed'; error: Error };
export interface ChildHandle {
  readonly pid: number;
  signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGKILL', authorize: () => Promise<boolean>): Promise<SignalOutcome>;
  wait(): Promise<ChildExit>;
}
export interface ChildSpec {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  logFd: number;
}

const WINDOWS_PROCESS_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$queriedPid = 0
if (-not [int]::TryParse($env:MAI_PROCESS_QUERY_PID, [ref]$queriedPid) -or $queriedPid -le 0) { exit 2 }
$record = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $queriedPid)
if ($null -eq $record) { exit 3 }
[pscustomobject]@{
  ProcessId = $record.ProcessId
  ParentProcessId = $record.ParentProcessId
  CreationDate = if ($null -eq $record.CreationDate) { $null } else { $record.CreationDate.ToUniversalTime().ToString('o') }
  CommandLine = $record.CommandLine
} | ConvertTo-Json -Compress
`;

const WINDOWS_LISTENER_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$queriedPort = 0
if (-not [int]::TryParse($env:MAI_PROCESS_QUERY_PORT, [ref]$queriedPort) -or $queriedPort -lt 1 -or $queriedPort -gt 65535) { exit 2 }
$record = Get-NetTCPConnection -State Listen -LocalPort $queriedPort | Select-Object -First 1
if ($null -eq $record) { exit 3 }
[pscustomobject]@{ LocalPort = $record.LocalPort; OwningProcess = $record.OwningProcess } | ConvertTo-Json -Compress
`;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function parsePid(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 && String(parsed) === value ? parsed : null;
}

function parsePort(value: unknown): number | null {
  const port = parsePid(value);
  return port !== null && port <= 65_535 ? port : null;
}

function normalizeBirth(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function decodeResult(result: ReturnType<typeof spawnArgvSync>): string | null {
  if (result.error || result.status !== 0) return null;
  return result.stdout.toString('utf8').replace(/^\uFEFF/, '');
}

function posixBirthId(pid: number): string | null {
  const executable = findExecutable('ps');
  if (!executable) return null;
  const result = spawnArgvSync(executable, ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 2_000,
    maxBuffer: 65_536,
  });
  const output = decodeResult(result);
  if (output === null) return null;
  const birth = normalizeBirth(output);
  return birth ? birth : null;
}

function parsePosixSnapshot(output: string): readonly PosixTreeRow[] | null {
  if (Buffer.byteLength(output) > 1_048_576) return null;
  const rows: PosixTreeRow[] = [];
  const seen = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*([1-9]\d*)\s+(0|[1-9]\d*)\s+(.+?)\s*$/.exec(line);
    if (!match) return null;
    const pid = parsePid(match[1]);
    const parentPid = Number(match[2]);
    const birthId = normalizeBirth(match[3]);
    if (pid === null || !Number.isSafeInteger(parentPid) || parentPid < 0 || !birthId || seen.has(pid)) return null;
    seen.add(pid);
    rows.push({ pid, parentPid, birthId });
    if (rows.length > 16_384) return null;
  }
  return rows;
}

async function posixSnapshot(): Promise<readonly PosixTreeRow[]> {
  const executable = findExecutable('ps');
  if (!executable) throw new Error('process snapshot unavailable');
  const result = spawnArgvSync(executable, ['-axo', 'pid=,ppid=,lstart='], {
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 2_000,
    maxBuffer: 1_048_576,
  });
  const output = decodeResult(result);
  const rows = output === null ? null : parsePosixSnapshot(output);
  if (rows === null) throw new Error('invalid process snapshot');
  return rows;
}

function validateSnapshot(rows: readonly PosixTreeRow[]): Map<number, PosixTreeRow> {
  if (rows.length > 16_384) throw new Error('process snapshot too large');
  const byPid = new Map<number, PosixTreeRow>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid < 1 || !Number.isSafeInteger(row.parentPid)
      || row.parentPid < 0 || !row.birthId || byPid.has(row.pid)) throw new Error('invalid process snapshot');
    byPid.set(row.pid, row);
  }
  return byPid;
}

function rootIsCallerOrAncestor(pid: number, selfPid: number, byPid: ReadonlyMap<number, PosixTreeRow>): boolean {
  let current = selfPid;
  const visited = new Set<number>();
  for (let hop = 0; hop < 128; hop++) {
    if (current === pid) return true;
    if (visited.has(current)) throw new Error('cyclic process ancestry');
    visited.add(current);
    const row = byPid.get(current);
    if (!row) throw new Error('process ancestry incomplete');
    if (row.parentPid === 0) return false;
    current = row.parentPid;
  }
  throw new Error('process ancestry too deep');
}

export async function terminatePosixTree(
  pid: number,
  ops: PosixTreeOps,
  authorize?: () => Promise<boolean>,
): Promise<void> {
  const deadline = ops.now() + 10_000;
  const budget = () => {
    if (ops.now() >= deadline) throw new Error('process tree termination timed out');
  };
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === ops.selfPid) throw new Error('unsafe tree root');
  budget();
  const rows = await ops.snapshot();
  const byPid = validateSnapshot(rows);
  if (rootIsCallerOrAncestor(pid, ops.selfPid, byPid)) throw new Error('unsafe tree root');
  const root = byPid.get(pid);
  if (!root) throw new Error('process root identity unavailable');
  const owned = [root];
  const seen = new Set([pid]);
  for (let index = 0; index < owned.length; index++) {
    const parent = owned[index];
    for (const row of rows) {
      if (row.parentPid !== parent.pid) continue;
      if (seen.has(row.pid) || row.pid <= 1 || row.pid === ops.selfPid) throw new Error('unsafe process tree');
      seen.add(row.pid);
      owned.push(row);
      if (owned.length > 64) throw new Error('process tree too large');
    }
  }
  const matches = async (row: PosixTreeRow): Promise<boolean> => {
    budget();
    if (!ops.isAlive(row.pid)) return false;
    const actual = await ops.birthId(row.pid);
    if (actual !== null && actual === row.birthId) return true;
    if (actual === null && !ops.isAlive(row.pid)) return false;
    throw new Error('process tree identity changed or unavailable');
  };
  if (!await matches(root)) {
    if (owned.length > 1) throw new Error('tree root exited before descendant authorization');
    return;
  }
  const deliver = async (row: PosixTreeRow, signal: 'SIGTERM' | 'SIGKILL') => {
    budget();
    if (authorize && !await authorize()) throw new Error('process tree authorization refused');
    if (!await matches(row)) return;
    try {
      ops.signal(row.pid, signal);
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') throw error;
    }
  };
  const waitGone = async (row: PosixTreeRow) => {
    const until = Math.min(deadline, ops.now() + 2_000);
    while (ops.now() < until) {
      if (!await matches(row)) return true;
      const remaining = until - ops.now();
      if (remaining <= 0) break;
      await ops.sleep(Math.min(25, remaining));
    }
    return !await matches(row);
  };
  for (const row of [...owned].reverse()) {
    if (row.pid === pid) {
      budget();
      const latest = await ops.snapshot();
      validateSnapshot(latest);
      if (latest.some(candidate => candidate.pid !== pid && seen.has(candidate.parentPid) && ops.isAlive(candidate.pid))) {
        throw new Error('process descendants remain or appeared during termination');
      }
    }
    if (!await matches(row)) continue;
    await deliver(row, 'SIGTERM');
    if (await waitGone(row)) continue;
    await deliver(row, 'SIGKILL');
    if (!await waitGone(row)) throw new Error('verified process remains alive after SIGKILL');
  }
}

interface WindowsProcessRecord {
  processId: number;
  parentProcessId: number;
  creationDate: string | null;
  commandLine: string | null;
}

function parseWindowsProcessRecord(value: unknown, requestedPid: number): WindowsProcessRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const processId = Reflect.get(value, 'ProcessId');
  const parentProcessId = Reflect.get(value, 'ParentProcessId');
  const creationDate = Reflect.get(value, 'CreationDate');
  const commandLine = Reflect.get(value, 'CommandLine');
  if (processId !== requestedPid || !Number.isSafeInteger(parentProcessId) || parentProcessId < 0) return null;
  if (creationDate !== null && typeof creationDate !== 'string') return null;
  if (commandLine !== null && typeof commandLine !== 'string') return null;
  return { processId, parentProcessId, creationDate, commandLine };
}

/** PowerShell pays a cold module auto-load on first use — CimCmdlets for
 *  `Win32_Process`, NetTCPIP (a CDXML module layered over CimCmdlets, so slower
 *  still) for `Get-NetTCPConnection` — on top of its own start cost. On a loaded
 *  Windows runner that exceeds a 2s budget, and the probe then reports a FAILED
 *  ancestry for a perfectly healthy process: CI run 34944749897 failed P07 that
 *  way and passed on same-SHA re-run.
 *
 *  A retry does NOT rescue it, which is worth recording because it is the
 *  obvious fix and it is wrong: EVERY spawn pays the load, so a second attempt
 *  at the same budget has the same failure probability — the d64b951 Windows job
 *  log carries eight separate "Preparing modules for first use" records inside
 *  six seconds. The pair that proves it in that one run: the fixture test P07c
 *  PASSED at 2204ms, so the retry machinery worked when attempt 2 was fast,
 *  while P07 against the real host still FAILED at 6121ms, so in production
 *  attempt 2 was not fast. (Do not read 6121ms as two timeouts — at ~2.1s each
 *  that is 4.2s; the walk had also completed several fast hops first.) The
 *  budget was the bug, not the attempt count.
 *
 *  10s is several times the cold path and costs nothing on a healthy host, where
 *  these queries answer in milliseconds. A probe that genuinely reaches it is
 *  wedged rather than cold, and every caller here fails closed on null.
 *
 *  Note for anyone changing this number: it is now EQUAL to terminateTree's own
 *  deadline (:176), so a single wedged probe inside matches() can consume that
 *  whole budget and surface as 'process tree termination timed out'. Not a
 *  regression — at any probe slow enough to matter the old budget returned null
 *  and matches() threw anyway — but raise this one further and tree termination
 *  is what gives first. One budget in one place: a second probe quietly keeping
 *  its own is how the first attempt at this covered only half the defect. */
const POWERSHELL_QUERY_BUDGET_MS = 10_000;

function powershellQuerySync(
  executable: string,
  query: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnArgvSync> {
  return spawnArgvSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query], {
    env: { ...process.env, ...env },
    timeout: POWERSHELL_QUERY_BUDGET_MS,
    maxBuffer: 65_536,
    windowsHide: true,
  });
}

/** `absent` is the probe's own verdict (WINDOWS_PROCESS_QUERY exits 3 when no
 * process has the pid); `failed` is everything else — no powershell, timeout,
 * overflow, unparsable output — and must never be read as "exited". */
type WindowsProbe = { kind: 'record'; value: unknown } | { kind: 'absent' } | { kind: 'failed' };

function windowsProcessProbe(pid: number): WindowsProbe {
  if (parsePid(pid) !== pid) return { kind: 'failed' };
  try {
    const executable = findExecutable('powershell.exe');
    if (!executable) return { kind: 'failed' };
    const result = powershellQuerySync(executable, WINDOWS_PROCESS_QUERY, { MAI_PROCESS_QUERY_PID: String(pid) });
    if (!result.error && result.status === 3) return { kind: 'absent' };
    const output = decodeResult(result);
    return output === null ? { kind: 'failed' } : { kind: 'record', value: JSON.parse(output) };
  } catch {
    return { kind: 'failed' };
  }
}

export function windowsProcessRecord(pid: number): unknown {
  const probe = windowsProcessProbe(pid);
  return probe.kind === 'record' ? probe.value : null;
}

function launchIdFromCommandLine(commandLine: string): string | null {
  const occurrences = commandLine.match(/(?:^|\s)--launch-id(?:=|\s+)/g) ?? [];
  if (occurrences.length !== 1) return null;
  const match = /(?:^|\s)--launch-id(?:=|\s+)([^\s"']+)/.exec(commandLine);
  if (!match) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(match[1])
    ? match[1].toLowerCase()
    : null;
}

function posixCommandLine(pid: number): string | null {
  const executable = findExecutable('ps');
  if (!executable) return null;
  return decodeResult(spawnArgvSync(executable, ['-o', 'args=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 2_000,
    maxBuffer: 65_536,
  }));
}

async function windowsListener(port: number): Promise<string | null> {
  const executable = findExecutable('powershell.exe');
  if (!executable) return null;
  const output = decodeResult(powershellQuerySync(executable, WINDOWS_LISTENER_QUERY, { MAI_PROCESS_QUERY_PORT: String(port) }));
  if (output === null) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const localPort = Reflect.get(parsed, 'LocalPort');
    const owner = Reflect.get(parsed, 'OwningProcess');
    return localPort === port && parsePid(owner) !== null ? `pid ${owner}` : null;
  } catch {
    return null;
  }
}

async function posixListener(port: number): Promise<string | null> {
  const executable = findExecutable('lsof');
  if (!executable) return null;
  const output = decodeResult(spawnArgvSync(executable, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    timeout: 2_000,
    maxBuffer: 65_536,
  }));
  const trimmed = output?.trim();
  return trimmed ? trimmed : null;
}

function alive(pid: number): boolean {
  if (parsePid(pid) === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function windowsTerminate(pid: number, authorize?: () => Promise<boolean>): Promise<void> {
  if (authorize && !await authorize()) throw new Error('process tree authorization refused');
  const executable = findExecutable('taskkill.exe');
  if (!executable) throw new Error('taskkill.exe unavailable');
  const result = spawnArgvSync(executable, ['/PID', String(pid), '/T', '/F'], {
    timeout: 2_000,
    maxBuffer: 65_536,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('taskkill.exe failed');
}

async function processAncestors(pid: number, platform: NodeJS.Platform): Promise<readonly number[] | null> {
  const ancestors: number[] = [];
  const visited = new Set<number>([pid]);
  let current = pid;
  for (let hop = 0; hop < 128; hop++) {
    let parent: number | null = null;
    if (platform === 'win32') {
      const probe = windowsProcessProbe(current);
      // Windows never reparents an orphan: an exited ancestor keeps its pid in
      // ParentProcessId and the chain simply ends there (every desktop session
      // has one — userinit exits after starting the shell). Only the probe's
      // own "no such process" verdict ends the chain; a failed probe, or the
      // requested pid itself being absent, is still a failed ancestry.
      if (probe.kind === 'absent' && current !== pid) return ancestors;
      if (probe.kind !== 'record') return null;
      const record = parseWindowsProcessRecord(probe.value, current);
      if (!record) return null;
      parent = record.parentProcessId;
    } else {
      const executable = findExecutable('ps');
      if (!executable) return null;
      const output = decodeResult(spawnArgvSync(executable, ['-o', 'ppid=', '-p', String(current)], {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 2_000,
        maxBuffer: 65_536,
      }));
      const text = output?.trim();
      if (!text || !/^(0|[1-9]\d*)$/.test(text)) return null;
      parent = Number(text);
    }
    if (parent === 0) return ancestors;
    if (parsePid(parent) === null || visited.has(parent)) return null;
    ancestors.push(parent);
    visited.add(parent);
    current = parent;
  }
  return null;
}

export function defaultProcessOps(): ProcessOps {
  const platform = process.platform;
  return {
    platform,
    isAlive: alive,
    async terminateTree(pid, authorize) {
      if (parsePid(pid) !== pid || pid <= 1 || pid === process.pid) throw new Error('unsafe tree root');
      if (platform === 'win32') {
        await windowsTerminate(pid, authorize);
        return;
      }
      await terminatePosixTree(pid, {
        selfPid: process.pid,
        snapshot: posixSnapshot,
        birthId: async target => posixBirthId(target),
        isAlive: alive,
        signal: (target, signal) => process.kill(target, signal),
        now: () => performance.now(),
        sleep: delay,
      }, authorize);
    },
    async describeTcpListener(port) {
      if (parsePort(port) !== port) return null;
      try {
        return platform === 'win32' ? await windowsListener(port) : await posixListener(port);
      } catch {
        return null;
      }
    },
    ancestorPids: pid => parsePid(pid) === pid ? processAncestors(pid, platform) : Promise.resolve(null),
    async processBirthId(pid) {
      if (parsePid(pid) !== pid) return null;
      if (platform !== 'win32') return posixBirthId(pid);
      return parseWindowsProcessRecord(windowsProcessRecord(pid), pid)?.creationDate ?? null;
    },
    async processLaunchId(pid) {
      if (parsePid(pid) !== pid) return null;
      const commandLine = platform === 'win32'
        ? parseWindowsProcessRecord(windowsProcessRecord(pid), pid)?.commandLine ?? null
        : posixCommandLine(pid);
      return commandLine === null ? null : launchIdFromCommandLine(commandLine);
    },
  };
}

function spawnSpec(spec: ChildSpec, detached: boolean) {
  if (spec.argv.length === 0 || !spec.argv[0]) throw new Error('child argv must contain an executable');
  return spawnArgv(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    detached,
    stdio: ['ignore', spec.logFd, spec.logFd],
    windowsHide: true,
  });
}

export function spawnAttached(spec: ChildSpec): ChildHandle {
  const child = spawnSpec(spec, false);
  const pid = child.pid;
  if (pid === undefined) throw new Error('child process has no pid');
  let exited = false;
  const exit = new Promise<ChildExit>(resolve => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
    child.once('error', () => {
      if (!exited) {
        exited = true;
        resolve({ code: 1, signal: null });
      }
    });
  });
  return {
    pid,
    async signal(sig, authorize) {
      if (exited) return { kind: 'gone' };
      try {
        if (process.platform === 'win32') {
          await defaultProcessOps().terminateTree(pid, authorize);
        } else {
          if (!await authorize()) throw new Error('process signal authorization refused');
          if (exited) return { kind: 'gone' };
          const delivered = child.kill(sig);
          if (!delivered && exited) return { kind: 'gone' };
          if (!delivered) throw new Error('process signal delivery failed');
        }
        return { kind: 'signalled' };
      } catch (error) {
        if (exited || errorCode(error) === 'ESRCH') return { kind: 'gone' };
        return { kind: 'failed', error: toError(error) };
      }
    },
    wait: () => exit,
  };
}

export function spawnDetached(spec: ChildSpec): number {
  const child = spawnSpec(spec, true);
  const pid = child.pid;
  if (pid === undefined) throw new Error('child process has no pid');
  child.once('error', () => undefined);
  child.unref();
  return pid;
}
