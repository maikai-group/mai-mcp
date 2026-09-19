import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeTool } from './support/fake-tool.js';
import type { PosixTreeOps, PosixTreeRow } from '../platform/processes.js';
import {
  defaultProcessOps,
  parsePid,
  spawnAttached,
  spawnDetached,
  terminatePosixTree,
  windowsProcessRecord,
} from '../platform/processes.js';

const roots: string[] = [];
const children = new Set<number>();
const savedPath = process.env.PATH;
const savedRecord = process.env.MAI_TEST_RECORD;

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedRecord === undefined) delete process.env.MAI_TEST_RECORD;
  else process.env.MAI_TEST_RECORD = savedRecord;
  for (const pid of children) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  children.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mai-platform-process-${label}-`));
  roots.push(root);
  return root;
}

function script(root: string, name: string, body: string): string {
  return installFakeTool(root, name, body);
}

function logFd(root: string): { fd: number; file: string } {
  const file = path.join(root, 'child.log');
  return { file, fd: fs.openSync(file, 'a', 0o600) };
}

function track(child: ReturnType<typeof spawn>): number {
  const pid = child.pid;
  if (pid === undefined) throw new Error('fixture has no pid');
  children.add(pid);
  child.once('close', () => children.delete(pid));
  return pid;
}

function injectedTree(
  rows: readonly PosixTreeRow[],
  configure?: (state: { alive: Set<number>; births: Map<number, string>; signals: string[]; clock: { value: number } }) => Partial<PosixTreeOps>,
): { ops: PosixTreeOps; state: { alive: Set<number>; births: Map<number, string>; signals: string[]; clock: { value: number } } } {
  const completeRows = rows.some(row => row.pid === 9000)
    ? rows
    : [...rows, { pid: 9000, parentPid: 0, birthId: 'self' }];
  const alive = new Set(completeRows.map(row => row.pid));
  const births = new Map(completeRows.map(row => [row.pid, row.birthId]));
  const signals: string[] = [];
  const clock = { value: 0 };
  const state = { alive, births, signals, clock };
  const overrides = configure?.(state) ?? {};
  const defaults: PosixTreeOps = {
    selfPid: 9000,
    snapshot: async () => completeRows,
    birthId: async pid => births.get(pid) ?? null,
    isAlive: pid => alive.has(pid),
    signal(pid, signalName) {
      signals.push(`${pid}:${signalName}`);
      if (signalName === 'SIGKILL') alive.delete(pid);
    },
    now: () => clock.value,
    async sleep(ms) { clock.value += ms; await Promise.resolve(); },
  };
  return { ops: { ...defaults, ...overrides }, state };
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let index = 0; index < 100; index++) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(20);
  }
}

describe('platform processes', () => {
  it('P01 — parses only canonical PID values within bounds', () => {
    expect([parsePid(1), parsePid(2_147_483_647), parsePid('42')]).toEqual([1, 2_147_483_647, 42]);
    for (const value of [0, -1, 1.5, Infinity, 2_147_483_648, '', '0', '+1', '-1', ' 1', '01', '1.0', '2147483648']) {
      expect(parsePid(value)).toBeNull();
    }
  });

  it('P02 — reports alive, dead, and EPERM liveness correctly', () => {
    expect(defaultProcessOps().isAlive(process.pid)).toBe(true);
    expect(defaultProcessOps().isAlive(2_147_483_647)).toBe(false);
    const failure = new Error('denied');
    Reflect.set(failure, 'code', 'EPERM');
    vi.spyOn(process, 'kill').mockImplementation(() => { throw failure; });
    expect(defaultProcessOps().isAlive(123)).toBe(true);
  });

  it('P03 — sends POSIX TERM then an independently authorized KILL', async () => {
    const fixture = injectedTree([{ pid: 100, parentPid: 1, birthId: 'root' }]);
    let authorizations = 0;
    await terminatePosixTree(100, fixture.ops, async () => { authorizations++; return true; });
    expect(fixture.state.signals).toEqual(['100:SIGTERM', '100:SIGKILL']);
    expect(authorizations).toBe(2);
  });

  it('P04 — invokes absolute taskkill with exact argv only after authorization', async () => {
    const root = tempRoot('p04');
    const record = path.join(root, 'record');
    script(root, 'taskkill.exe', 'printf "%s\\n" "$@" > "$MAI_TEST_RECORD"');
    process.env.PATH = root;
    process.env.MAI_TEST_RECORD = record;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    let authorized = 0;
    await defaultProcessOps().terminateTree(4321, async () => { authorized++; return true; });
    expect(fs.readFileSync(record, 'utf8').trim().split('\n')).toEqual(['/PID', '4321', '/T', '/F']);
    expect(authorized).toBe(1);
  });

  it('P05 — keeps Windows diagnostic metacharacters in the environment channel and never a shell command', () => {
    const root = tempRoot('p05');
    const marker = path.join(root, 'marker');
    script(root, 'powershell.exe', `printf '{"ProcessId":%s,"ParentProcessId":1,"CreationDate":"x","CommandLine":"node --launch-id 11111111-1111-4111-8111-111111111111"}' "$MAI_PROCESS_QUERY_PID"`);
    process.env.PATH = root;
    expect(windowsProcessRecord(123)).toBeTruthy();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('P06 — returns listener diagnostics on success and null on failure', async () => {
    // POSIX lookup premise: findExecutable under a linux/darwin spec requires an execute bit, which Windows never reports, so the lsof/ps fixtures can only resolve on a POSIX host.
    if (process.platform === 'win32') return;
    const root = tempRoot('p06');
    script(root, 'lsof', 'printf "node 123 owner TCP *:4321 (LISTEN)\\n"');
    process.env.PATH = root;
    expect(await defaultProcessOps().describeTcpListener(4321)).toContain('LISTEN');
    script(root, 'lsof', 'exit 1');
    expect(await defaultProcessOps().describeTcpListener(4321)).toBeNull();
    expect(await defaultProcessOps().describeTcpListener(0)).toBeNull();
  });

  it('P06b — a Windows listener probe slower than the old budget still answers', async () => {
    // The listener probe is the ancestry probe's twin: same powershell, same
    // shared budget, and Get-NetTCPConnection auto-loads NetTCPIP — a CDXML
    // module layered over CimCmdlets, so its cold load is SLOWER than the one
    // that failed P07 in CI. Both go through powershellQuerySync so one budget
    // covers both; this pins the listener half.
    const root = tempRoot('p06b');
    const log = path.join(root, 'attempts');
    script(root, 'powershell.exe', `printf 'x' >> ${JSON.stringify(log)}
end=$(( SECONDS + 4 )); while [ "$SECONDS" -lt "$end" ]; do :; done
printf '{"LocalPort":%s,"OwningProcess":777}' "$MAI_PROCESS_QUERY_PORT"`);
    process.env.PATH = root;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(await defaultProcessOps().describeTcpListener(4321)).toBe('pid 777');
    expect(fs.readFileSync(log, 'utf8')).toBe('x');
  });

  it('P07 — returns bounded ancestors and refuses failed or cyclic ancestry', async () => {
    const ancestors = await defaultProcessOps().ancestorPids(process.pid);
    expect(ancestors).not.toBeNull();
    expect(await defaultProcessOps().ancestorPids(0)).toBeNull();
    const root = tempRoot('p07');
    script(root, 'powershell.exe', `printf '{"ProcessId":%s,"ParentProcessId":%s,"CreationDate":"x","CommandLine":"x"}' "$MAI_PROCESS_QUERY_PID" "$MAI_PROCESS_QUERY_PID"`);
    process.env.PATH = root;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(await defaultProcessOps().ancestorPids(123)).toBeNull();
  });

  it('P07c — a Windows probe slower than the old budget still answers, in exactly one attempt', async () => {
    // A cold CimCmdlets auto-load plus powershell's own start outran the old 2s
    // budget on a loaded host, and the probe reported a FAILED ancestry for a
    // healthy process: CI run 34944749897 failed P07 that way and passed on
    // same-SHA re-run. A retry does not fix it — killing attempt 1 at the budget
    // discards the module load, so attempt 2 starts equally cold — at d64b951
    // the retried build still failed P07 on the real host. The budget is the
    // fix, so this asserts a slow-but-alive probe answers. The attempt count is
    // pinned too, but be precise about what that catches: the fake answers at
    // ~3.3s, inside the budget, so a CONDITIONAL retry would never fire here
    // and would still pass. Only an unconditional retry fails it. The control
    // that proves the budget is the mutation — set the constant to 2_000.
    const root = tempRoot('p07c');
    const log = path.join(root, 'attempts');
    // The probe hands the fake its own env, whose PATH is this fixture root, so
    // only bash BUILTINS resolve in here — `sleep` silently does not run. The
    // spin uses $SECONDS, whose 1s granularity puts the real wait at 3-4s:
    // comfortably past the old 2s budget and far inside the new one.
    script(root, 'powershell.exe', `printf 'x' >> ${JSON.stringify(log)}
end=$(( SECONDS + 4 )); while [ "$SECONDS" -lt "$end" ]; do :; done
printf '{"ProcessId":%s,"ParentProcessId":0,"CreationDate":"x","CommandLine":"x"}' "$MAI_PROCESS_QUERY_PID"`);
    process.env.PATH = root;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(await defaultProcessOps().ancestorPids(123)).toEqual([]);
    expect(fs.readFileSync(log, 'utf8')).toBe('x');
  });

  it('P07b — an exited Windows ancestor ends the chain; a failed probe or an absent requested pid still refuses', async () => {
    const root = tempRoot('p07b');
    // pid 123 has parent 999; 999 is gone (the probe's own exit 3). pid 456 has
    // parent 888, whose probe FAILS (exit 1) — a failure beyond the first hop
    // must not be read as an exited ancestor. Anything else is a probe failure.
    script(root, 'powershell.exe', `case "$MAI_PROCESS_QUERY_PID" in
  123) printf '{"ProcessId":123,"ParentProcessId":999,"CreationDate":"x","CommandLine":"x"}' ;;
  999) exit 3 ;;
  456) printf '{"ProcessId":456,"ParentProcessId":888,"CreationDate":"x","CommandLine":"x"}' ;;
  *) exit 1 ;;
esac`);
    process.env.PATH = root;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(await defaultProcessOps().ancestorPids(123)).toEqual([999]);
    expect(await defaultProcessOps().ancestorPids(456)).toBeNull(); // red against the pre-repair walk, which returned [888]
    expect(await defaultProcessOps().ancestorPids(999)).toBeNull();
    expect(await defaultProcessOps().ancestorPids(77)).toBeNull();
  });

  it('P08 — refuses termination when the captured birth identity is false', async () => {
    const fixture = injectedTree([{ pid: 100, parentPid: 1, birthId: 'old' }], state => {
      state.births.set(100, 'new');
      return {};
    });
    await expect(terminatePosixTree(100, fixture.ops)).rejects.toThrow('identity');
    expect(fixture.state.signals).toEqual([]);
  });

  it('P09 — attached wait reaps once and propagates the exact exit code and signal', async () => {
    const root = tempRoot('p09');
    const log = logFd(root);
    const handle = spawnAttached({ argv: [process.execPath, '-e', 'process.exit(23)'], env: {}, cwd: root, logFd: log.fd });
    children.add(handle.pid);
    const first = handle.wait();
    const second = handle.wait();
    expect(first).toBe(second);
    expect(await first).toEqual({ code: 23, signal: null });
    children.delete(handle.pid);
    fs.closeSync(log.fd);
  });

  it('P10 — reports a delivered signal and then the real reaped exit', async () => {
    // POSIX signal semantics: Windows has no SIGTERM/SIGKILL delivery to report; the product ends the tree with taskkill and reaps an exit code instead.
    if (process.platform === 'win32') return;
    const root = tempRoot('p10');
    const log = logFd(root);
    const handle = spawnAttached({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], env: {}, cwd: root, logFd: log.fd });
    children.add(handle.pid);
    expect(await handle.signal('SIGTERM', async () => true)).toEqual({ kind: 'signalled' });
    expect(await handle.wait()).toEqual({ code: null, signal: 'SIGTERM' });
    children.delete(handle.pid);
    fs.closeSync(log.fd);
  });

  it('P11 — detached launch outlives the launching call and returns observation-only PID', async () => {
    const root = tempRoot('p11');
    const log = logFd(root);
    const pid = spawnDetached({ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'], env: {}, cwd: root, logFd: log.fd });
    children.add(pid);
    expect(defaultProcessOps().isAlive(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
    await waitUntilGone(pid);
    fs.closeSync(log.fd);
  });

  it('P12 — both child shapes use explicit combined log stdio without shell interpretation', async () => {
    const root = tempRoot('p12');
    const attachedLog = logFd(root);
    const handle = spawnAttached({
      argv: [process.execPath, '-e', 'console.log(process.argv[1]);console.error("stderr")', 'a&b'], env: {}, cwd: root, logFd: attachedLog.fd,
    });
    children.add(handle.pid);
    await handle.wait();
    children.delete(handle.pid);
    fs.closeSync(attachedLog.fd);
    expect(fs.readFileSync(attachedLog.file, 'utf8')).toContain('a&b\nstderr');
    const detachedFile = path.join(root, 'detached.log');
    const detachedFd = fs.openSync(detachedFile, 'a', 0o600);
    const pid = spawnDetached({ argv: [process.execPath, '-e', 'console.log("out");console.error("err")'], env: {}, cwd: root, logFd: detachedFd });
    children.add(pid);
    await waitUntilGone(pid);   // the child exits after printing; a fixed sleep raced a cold start on loaded macOS runners
    fs.closeSync(detachedFd);
    expect(fs.readFileSync(detachedFile, 'utf8')).toContain('out\nerr');
  });

  it('P13 — Windows authorization rejection returns failed with the same Error', async () => {
    const root = tempRoot('p13');
    const log = logFd(root);
    const handle = spawnAttached({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], env: {}, cwd: root, logFd: log.fd });
    children.add(handle.pid);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const refusal = new Error('authorization rejected');
    const outcome = await handle.signal('SIGTERM', async () => { throw refusal; });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('expected failed outcome');
    expect(outcome.error).toBe(refusal);
    process.kill(handle.pid, 'SIGKILL');
    await handle.wait();
    children.delete(handle.pid);
    fs.closeSync(log.fd);
  });

  it('P14 — reports gone for an already exited attached child', async () => {
    const root = tempRoot('p14');
    const log = logFd(root);
    const handle = spawnAttached({ argv: [process.execPath, '-e', 'process.exit(0)'], env: {}, cwd: root, logFd: log.fd });
    await handle.wait();
    expect(await handle.signal('SIGTERM', async () => true)).toEqual({ kind: 'gone' });
    fs.closeSync(log.fd);
  });

  it('P15 — reads a matching launch id from the live process command line', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', '--launch-id', id], { stdio: 'ignore' });
    const pid = track(child);
    expect(await defaultProcessOps().processLaunchId(pid)).toBe(id);
  });

  it('P16 — returns null when the live process launch id does not match the required shape', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', '--other-id', 'x'], { stdio: 'ignore' });
    const pid = track(child);
    expect(await defaultProcessOps().processLaunchId(pid)).toBeNull();
  });

  it('P17 — returns null for an exited process birth and launch identity', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = track(child);
    await once(child, 'close');
    expect(await defaultProcessOps().processBirthId(pid)).toBeNull();
    expect(await defaultProcessOps().processLaunchId(pid)).toBeNull();
  });

  it('P18 — returns null when identity probes are denied or error', async () => {
    process.env.PATH = '';
    expect(await defaultProcessOps().processBirthId(process.pid)).toBeNull();
    expect(await defaultProcessOps().processLaunchId(process.pid)).toBeNull();
  });

  it('P19 — refuses a recycled birth identity even when a launch id could match', async () => {
    const fixture = injectedTree([{ pid: 100, parentPid: 1, birthId: 'captured' }], state => {
      state.births.set(100, 'recycled');
      return {};
    });
    await expect(terminatePosixTree(100, fixture.ops, async () => true)).rejects.toThrow('identity');
    expect(fixture.state.signals).toEqual([]);
  });

  it('P20 — uses the exact constant Windows probe argv, PID env, timeout channel, and no -Args', () => {
    const root = tempRoot('p20');
    const record = path.join(root, 'argv');
    process.env.MAI_TEST_RECORD = record;
    process.env.PATH = root;
    script(root, 'powershell.exe', `printf '%s\\n' "$@" > "$MAI_TEST_RECORD"; printf '{"ProcessId":%s,"ParentProcessId":1,"CreationDate":"2026-01-01T00:00:00.0000000Z","CommandLine":"node --launch-id 11111111-1111-4111-8111-111111111111"}' "$MAI_PROCESS_QUERY_PID"`);
    expect(windowsProcessRecord(456)).toBeTruthy();
    const argv = fs.readFileSync(record, 'utf8').trim().split('\n');
    expect(argv.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(argv).not.toContain('-Args');
    expect(argv.slice(4).join('\n')).toContain('MAI_PROCESS_QUERY_PID');
  });

  it.skipIf(process.platform !== 'win32')('P21 — proves PID, birth, and launch id through a native Windows Node fixture', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', '--launch-id', id], { stdio: 'ignore' });
    const pid = track(child);
    expect(await defaultProcessOps().processBirthId(pid)).toBeTruthy();
    expect(await defaultProcessOps().processLaunchId(pid)).toBe(id);
  });

  it('P22 — preserves quoted and metacharacter command-line data across the Windows probe channel', async () => {
    const root = tempRoot('p22');
    const id = '33333333-3333-4333-8333-333333333333';
    const payload = JSON.stringify({
      ProcessId: 321,
      ParentProcessId: 1,
      CreationDate: 'x',
      CommandLine: `node "a&b (c) %雪" --launch-id ${id}`,
    });
    script(root, 'powershell.exe', `printf '%s' '${payload}'`);
    process.env.PATH = root;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(await defaultProcessOps().processLaunchId(321)).toBe(id);
  });

  it('P23 — returns null for duplicate launch flags or an invalid UUID', async () => {
    const root = tempRoot('p23');
    process.env.PATH = root;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    script(root, 'powershell.exe', `printf '{"ProcessId":%s,"ParentProcessId":1,"CreationDate":"x","CommandLine":"node --launch-id bad"}' "$MAI_PROCESS_QUERY_PID"`);
    expect(await defaultProcessOps().processLaunchId(111)).toBeNull();
    script(root, 'powershell.exe', `printf '{"ProcessId":%s,"ParentProcessId":1,"CreationDate":"x","CommandLine":"node --launch-id 11111111-1111-4111-8111-111111111111 --launch-id 22222222-2222-4222-8222-222222222222"}' "$MAI_PROCESS_QUERY_PID"`);
    expect(await defaultProcessOps().processLaunchId(111)).toBeNull();
  });

  it('P24 — refuses SIGKILL when identity is lost after TERM', async () => {
    let termDelivered = false;
    const fixture = injectedTree([{ pid: 100, parentPid: 1, birthId: 'root' }], state => ({
      birthId: async () => termDelivered ? 'changed' : 'root',
      signal(pid, signalName) { state.signals.push(`${pid}:${signalName}`); if (signalName === 'SIGTERM') termDelivered = true; },
    }));
    await expect(terminatePosixTree(100, fixture.ops, async () => true)).rejects.toThrow('identity');
    expect(fixture.state.signals).toEqual(['100:SIGTERM']);
  });

  it('P25 — failed signal does not settle wait and later reap reports its actual exit', async () => {
    // POSIX signal semantics: Windows has no SIGTERM/SIGKILL delivery to report; the product ends the tree with taskkill and reaps an exit code instead.
    if (process.platform === 'win32') return;
    const root = tempRoot('p25');
    const log = logFd(root);
    const handle = spawnAttached({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], env: {}, cwd: root, logFd: log.fd });
    children.add(handle.pid);
    expect((await handle.signal('SIGTERM', async () => { throw new Error('denied'); })).kind).toBe('failed');
    const pending = await Promise.race([handle.wait().then(() => false), delay(50).then(() => true)]);
    expect(pending).toBe(true);
    process.kill(handle.pid, 'SIGKILL');
    expect(await handle.wait()).toEqual({ code: null, signal: 'SIGKILL' });
    children.delete(handle.pid);
    fs.closeSync(log.fd);
  });

  it.skipIf(process.platform === 'win32')('P26 — terminates a native POSIX parent/child/grandchild tree deepest first without touching an unrelated process', async () => {
    const childCode = `const{spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000)`;
    const parentCode = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',d=>console.log(JSON.stringify({child:c.pid,grand:Number(String(d).trim())})));setInterval(()=>{},1000)`;
    const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'inherit'] });
    const parentPid = track(parent);
    const stdout = parent.stdout;
    if (!stdout) throw new Error('parent stdout unavailable');
    const values = await once(stdout, 'data');
    const parsed: unknown = JSON.parse(String(values[0]).trim());
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid fixture output');
    const childPid = Reflect.get(parsed, 'child');
    const grandPid = Reflect.get(parsed, 'grand');
    if (parsePid(childPid) === null || parsePid(grandPid) === null) throw new Error('invalid fixture pids');
    children.add(childPid);
    children.add(grandPid);
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const unrelatedPid = track(unrelated);
    await defaultProcessOps().terminateTree(parentPid, async () => true);
    for (const pid of [parentPid, childPid, grandPid]) await waitUntilGone(pid);
    expect(defaultProcessOps().isAlive(parentPid)).toBe(false);
    expect(defaultProcessOps().isAlive(childPid)).toBe(false);
    expect(defaultProcessOps().isAlive(grandPid)).toBe(false);
    expect(defaultProcessOps().isAlive(unrelatedPid)).toBe(true);
    children.delete(childPid);
    children.delete(grandPid);
  });

  it('P27 — refuses every injected unsafe tree, identity, authorization, and deadline condition', async () => {
    const row = { pid: 100, parentPid: 1, birthId: 'root' };
    const changed = injectedTree([row], state => { state.births.set(100, 'changed'); return {}; });
    await expect(terminatePosixTree(100, changed.ops)).rejects.toThrow();
    const denied = injectedTree([row], () => ({ snapshot: async () => { throw new Error('denied'); } }));
    await expect(terminatePosixTree(100, denied.ops)).rejects.toThrow('denied');
    const duplicate = injectedTree([row, row]);
    await expect(terminatePosixTree(100, duplicate.ops)).rejects.toThrow('invalid');
    const cyclic = injectedTree([{ pid: 100, parentPid: 101, birthId: 'a' }, { pid: 101, parentPid: 100, birthId: 'b' }]);
    await expect(terminatePosixTree(100, cyclic.ops)).rejects.toThrow('unsafe');
    const oversizedRows = Array.from({ length: 16_385 }, (_, index) => ({ pid: index + 2, parentPid: 1, birthId: String(index) }));
    const oversized = injectedTree(oversizedRows);
    await expect(terminatePosixTree(2, oversized.ops)).rejects.toThrow('large');
    const caller = injectedTree([{ pid: 100, parentPid: 1, birthId: 'root' }], () => ({ selfPid: 100 }));
    await expect(terminatePosixTree(100, caller.ops)).rejects.toThrow('unsafe');
    const ancestor = injectedTree([{ pid: 100, parentPid: 1, birthId: 'root' }, { pid: 9000, parentPid: 100, birthId: 'self' }]);
    await expect(terminatePosixTree(100, ancestor.ops)).rejects.toThrow('unsafe');
    let missingSelfAuthorizations = 0;
    const missingSelf = injectedTree([row], state => ({
      snapshot: async () => [row],
      signal(pid, signalName) { state.signals.push(`${pid}:${signalName}`); },
    }));
    await expect(terminatePosixTree(100, missingSelf.ops, async () => {
      missingSelfAuthorizations++;
      return true;
    })).rejects.toThrow('incomplete');
    expect(missingSelfAuthorizations).toBe(0);
    expect(missingSelf.state.signals).toEqual([]);
    let missingIntermediateAuthorizations = 0;
    const incompleteCaller = { pid: 9000, parentPid: 8000, birthId: 'self' };
    const missingIntermediate = injectedTree([row, incompleteCaller]);
    await expect(terminatePosixTree(100, missingIntermediate.ops, async () => {
      missingIntermediateAuthorizations++;
      return true;
    })).rejects.toThrow('incomplete');
    expect(missingIntermediateAuthorizations).toBe(0);
    expect(missingIntermediate.state.signals).toEqual([]);
    let approvals = 0;
    const lostAuth = injectedTree([row]);
    await expect(terminatePosixTree(100, lostAuth.ops, async () => ++approvals === 1)).rejects.toThrow('authorization');
    const surviving = injectedTree([row], state => ({ signal(pid, signalName) { state.signals.push(`${pid}:${signalName}`); } }));
    await expect(terminatePosixTree(100, surviving.ops, async () => true)).rejects.toThrow('remains alive');
    let snapshots = 0;
    const completeSelf = { pid: 9000, parentPid: 0, birthId: 'self' };
    const appeared = injectedTree([row], state => ({
      snapshot: async () => ++snapshots === 1
        ? [row, completeSelf]
        : [row, completeSelf, { pid: 101, parentPid: 100, birthId: 'new' }],
      signal(pid, signalName) { state.signals.push(`${pid}:${signalName}`); state.alive.delete(pid); },
      isAlive: pid => pid === 101 || state.alive.has(pid),
    }));
    await expect(terminatePosixTree(100, appeared.ops, async () => true)).rejects.toThrow('appeared');
    const rootExited = injectedTree([row], state => { state.alive.delete(100); return {}; });
    await expect(terminatePosixTree(100, rootExited.ops)).resolves.toBeUndefined();
    expect(rootExited.state.signals).toEqual([]);
    let clockReads = 0;
    const timedOut = injectedTree([row], () => ({ now: () => clockReads++ === 0 ? 0 : 10_000 }));
    await expect(terminatePosixTree(100, timedOut.ops)).rejects.toThrow('timed out');
  });
});
