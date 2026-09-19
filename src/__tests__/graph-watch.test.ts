import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWatchScheduler } from '../graph/watch-scheduler.js';
import { graphGitDirectories, readWatchCensus, WatchChanges, type WatchCensus } from '../graph/watch-changes.js';
import { startGraphWatch, type GraphWatchController, type WatchFactory } from '../graph/watch.js';
import { runWatchSession } from '../graph/watch-cli.js';

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}
function fixture(files: Record<string, string> = { 'a.ts': 'export const a = 1;' }) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-graph-watch-')));
  dirs.push(repo);
  const file = (name: string) => path.join(repo, name);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init');
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), contents);
  }
  git('add', '.'); git('commit', '-m', 'fixture');
  return { repo, file, git };
}
const synthetic = path.join(fs.realpathSync.native(process.cwd()), '__watch_fixture__');
const census = (roots: readonly string[]): WatchCensus => new Map(roots.map(root => [root, new Set([path.join(root, 'a.ts')])]));
function clockScheduler(update = vi.fn(async () => {}), check = vi.fn(async () => true)) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const report = vi.fn();
  const scheduler = createWatchScheduler({ update, check, report, now: () => Date.now() });
  stops.push(scheduler.stop);
  return { ...scheduler, update, check, report };
}
async function own(controller: Promise<GraphWatchController>) {
  const result = await controller; stops.push(result.stop); return result;
}
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await Promise.all(stops.splice(0).map(stop => stop()));
  vi.useRealTimers(); vi.restoreAllMocks();
  dirs.splice(0).reverse().forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('graph watch scheduler', () => {
  it('starts only when armed, with unconditional catch-up and a two-second quiet window plus 60-second floor', async () => {
    const s = clockScheduler(undefined, vi.fn(async () => false));
    s.notify(); await vi.advanceTimersByTimeAsync(10_000); expect(s.update).not.toHaveBeenCalled();
    s.start(); await vi.advanceTimersByTimeAsync(0); expect(s.update).toHaveBeenCalledTimes(1);
    s.check.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(59_000); s.notify();
    await vi.advanceTimersByTimeAsync(1_000); s.notify();
    await vi.advanceTimersByTimeAsync(1_999); expect(s.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(s.update).toHaveBeenCalledTimes(2);
  });
  it.each(['untracked', 'git'])('does not let continuous %s noise starve a tracked edit', async noise => {
    const changes = new WatchChanges([synthetic], [], async () => census([synthetic])); await changes.prime();
    const s = clockScheduler(undefined, vi.fn(() => changes.check()));
    s.start(); await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(59_000);
    changes.source(synthetic, 'a.ts'); s.notify();
    for (let i = 0; i < 121; i++) {
      if (noise === 'git') changes.git(synthetic); else changes.source(synthetic, 'untracked.log');
      s.notify(); await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(s.update).toHaveBeenCalledTimes(2);
  });
  it('retains events during an update without overlapping passes', async () => {
    const blocked = gate(); const update = vi.fn(async () => { if (update.mock.calls.length === 1) await blocked.promise; });
    const s = clockScheduler(update); s.start(); await vi.advanceTimersByTimeAsync(0);
    s.notify(); await vi.advanceTimersByTimeAsync(120_000); expect(update).toHaveBeenCalledTimes(1);
    blocked.resolve(); await vi.advanceTimersByTimeAsync(1); expect(update).toHaveBeenCalledTimes(2);
  });
  it('retains an event arriving during the census', async () => {
    const blocked = gate(); const check = vi.fn(async () => { if (check.mock.calls.length === 1) await blocked.promise; return true; });
    const s = clockScheduler(undefined, check); s.start(); await vi.advanceTimersByTimeAsync(0);
    s.notify(); blocked.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(s.update).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(60_000);
    expect(s.update).toHaveBeenCalledTimes(2);
  });
  it.each(['update', 'census'])('retries a %s failure with bounded redacted diagnostics and no hot loop', async failure => {
    const update = vi.fn(async () => {}); const check = vi.fn(async () => true);
    if (failure === 'update') update.mockRejectedValueOnce(new Error('private update details'));
    else check.mockRejectedValueOnce(new Error('private path'));
    const s = clockScheduler(update, check); s.start(); await vi.advanceTimersByTimeAsync(0);
    expect(s.report).toHaveBeenCalledWith('Graph watch pass failed; retrying after the minimum interval.');
    const count = update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59_999); expect(update).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); expect(update).toHaveBeenCalledTimes(count + 1);
  });
  it('ignores an irrelevant batch after startup and waits for an active pass on stop', async () => {
    const blocked = gate(); const s = clockScheduler(undefined, vi.fn(async () => false));
    s.start(); await vi.advanceTimersByTimeAsync(0); s.notify(); await vi.advanceTimersByTimeAsync(60_000);
    expect(s.update).toHaveBeenCalledTimes(1);
    s.check.mockResolvedValue(true); s.update.mockImplementation(async () => blocked.promise);
    s.notify(); await vi.advanceTimersByTimeAsync(2_000);
    let stopped = false; const stopping = s.stop().then(() => { stopped = true; });
    s.notify(); await vi.advanceTimersByTimeAsync(120_000); expect(stopped).toBe(false);
    blocked.resolve(); await stopping; expect(stopped).toBe(true); expect(s.update).toHaveBeenCalledTimes(2);
  });
});

describe('graph watch source authority', () => {
  it('accepts tracked hidden/build files while rejecting excluded, untracked and escaping paths', async () => {
    const f = fixture({ '.hidden.ts': 'one', 'build/a.ts': 'two', 'excluded.ts': 'three' });
    const changes = new WatchChanges([f.repo], [f.file('excluded.ts')]); await changes.prime();
    for (const name of ['.hidden.ts', 'build/a.ts']) { changes.source(f.repo, name); expect(await changes.check()).toBe(true); }
    changes.source(f.repo, 'untracked.ts'); expect(await changes.check()).toBe(false);
    expect(changes.source(f.repo, 'excluded.ts')).toBe(false);
    expect(changes.source(f.repo, '../escape.ts')).toBe(false);
    expect(changes.source(f.repo, f.file('.hidden.ts'))).toBe(false);
    changes.source(f.repo, null); expect(await changes.check()).toBe(true);
  });
  it('detects staged additions and cached removals while ignoring Git-only noise', async () => {
    const f = fixture(); const changes = new WatchChanges([f.repo], []); await changes.prime();
    changes.git(f.repo); expect(await changes.check()).toBe(false);
    fs.writeFileSync(f.file('new.ts'), 'new'); f.git('add', 'new.ts');
    changes.git(f.repo); expect(await changes.check()).toBe(true);
    f.git('rm', '--cached', 'new.ts'); expect(fs.existsSync(f.file('new.ts'))).toBe(true);
    changes.git(f.repo); expect(await changes.check()).toBe(true);
    changes.source(f.repo, 'new.ts'); expect(await changes.check()).toBe(false);
  });
  it('uses previous membership for deletions and directory hints with nested-root ownership', async () => {
    const f = fixture({ 'outer.ts': 'outer', 'nested/src/a.ts': 'inner' });
    const nested = f.file('nested'); const changes = new WatchChanges([f.repo, nested], []); await changes.prime();
    expect((await readWatchCensus([f.repo, nested], [])).get(f.repo)).toEqual(new Set([f.file('outer.ts')]));
    changes.source(f.repo, 'nested/src'); expect(await changes.check()).toBe(true);
    fs.unlinkSync(f.file('nested/src/a.ts')); changes.source(f.repo, 'nested'); expect(await changes.check()).toBe(true);
  });
  it('fails closed on an unavailable index and retries retained hints after repair', async () => {
    const f = fixture(); const changes = new WatchChanges([f.repo], []); await changes.prime();
    const index = fs.readFileSync(f.file('.git/index')); fs.writeFileSync(f.file('.git/index'), 'broken');
    changes.source(f.repo, 'a.ts'); await expect(changes.check()).rejects.toThrow('source census unavailable');
    fs.writeFileSync(f.file('.git/index'), index); expect(await changes.check()).toBe(true);
  });
  it('rejects an unmerged index as unknown evidence', async () => {
    const f = fixture(); const original = f.git('branch', '--show-current').trim();
    f.git('checkout', '-b', 'other'); fs.writeFileSync(f.file('a.ts'), 'other'); f.git('commit', '-am', 'other');
    f.git('checkout', original); fs.writeFileSync(f.file('a.ts'), 'main'); f.git('commit', '-am', 'main');
    expect(() => f.git('merge', 'other')).toThrow();
    await expect(readWatchCensus([f.repo], [])).rejects.toThrow('source census unavailable');
  });
  it('watches both linked-worktree Git directories and observes index-only changes', async () => {
    const f = fixture(); const linked = f.file('linked'); f.git('worktree', 'add', '--detach', linked, 'HEAD');
    try {
      const realLinked = fs.realpathSync.native(linked); const gitDirs = await graphGitDirectories(realLinked);
      expect(gitDirs).toHaveLength(2); expect(gitDirs).toContain(f.file('.git'));
      const changes = new WatchChanges([realLinked], []); await changes.prime();
      execFileSync('git', ['-C', realLinked, 'rm', '--cached', 'a.ts']);
      changes.git(realLinked); expect(await changes.check()).toBe(true);
    } finally { f.git('worktree', 'remove', '--force', linked); }
  });
  it.skipIf(process.platform === 'win32')('rejects symlink escapes', async () => {
    const f = fixture(); const outside = fixture(); fs.symlinkSync(outside.repo, f.file('link'));
    const changes = new WatchChanges([f.repo], []); await changes.prime();
    expect(changes.source(f.repo, 'link/a.ts')).toBe(false);
  });
  it('caps pending paths at 1024 and conservatively collapses overflow', async () => {
    const f = fixture(); const changes = new WatchChanges([f.repo], []); await changes.prime();
    for (let i = 0; i < 1024; i++) changes.source(f.repo, `untracked-${i}`);
    expect(await changes.check()).toBe(false);
    for (let i = 0; i < 1025; i++) changes.source(f.repo, `untracked-${i}`);
    expect(await changes.check()).toBe(true);
  });
  it('retains content hints and consumes membership changes observed during a census', async () => {
    const root = synthetic; let files = new Set([path.join(root, 'a.ts')]);
    const blocked = gate(); let wait = false;
    const changes = new WatchChanges([root], [], async () => { if (wait) await blocked.promise; return new Map([[root, files]]); });
    await changes.prime(); changes.source(root, 'untracked'); wait = true; const checking = changes.check();
    files = new Set([...files, path.join(root, 'new.ts')]); changes.git(root); changes.source(root, 'a.ts'); blocked.resolve();
    expect(await checking).toBe(true); expect(await changes.check()).toBe(true); expect(await changes.check()).toBe(false);
  });
});

describe('graph watch subscriptions and lifecycle', () => {
  it('deduplicates physical roots and Git directories, installing everything before catch-up', async () => {
    const nested = path.join(synthetic, 'nested'); const roots = [synthetic, nested];
    const installed: Array<{ target: string; recursive: boolean; change: (name: string | null) => void; failed: () => void }> = [];
    const close = vi.fn(); const update = vi.fn(async () => { expect(installed).toHaveLength(2); });
    const watcher = await own(startGraphWatch({ repos: roots, excludes: [], update, report: vi.fn(), census: async () => census(roots),
      watch: (target, recursive, change, failed) => { installed.push({ target, recursive, change, failed }); return { close }; },
      gitDirectories: async () => [path.join(synthetic, '.git')], debounceMs: 5, intervalMs: 10,
    }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(installed.map(item => item.recursive)).toEqual([true, false]);
    installed[0].change('nested/a.ts'); await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    installed[0].failed(); expect(await watcher.done).toBe(1); expect(close).toHaveBeenCalledTimes(2);
  });
  it('retains healthy subscriptions and exits nonzero when none can start', async () => {
    const roots = [synthetic, synthetic + '-other']; const report = vi.fn();
    const watch: WatchFactory = target => { if (target === synthetic) throw new Error('private'); return { close() {} }; };
    const watcher = await own(startGraphWatch({ repos: roots, excludes: [], update: async () => {}, report,
      watch, census: async () => census(roots), gitDirectories: async () => [] }));
    expect(report).toHaveBeenCalledWith('Graph watch subscription unavailable; watching any remaining roots.');
    await watcher.stop(); expect(await watcher.done).toBe(0);
    const failed = await own(startGraphWatch({ repos: [synthetic], excludes: [], update: async () => {}, report,
      watch, census: async () => census([synthetic]), gitDirectories: async () => [] }));
    expect(await failed.done).toBe(1);
  });
  it.each(['SIGINT', 'SIGTERM'])('handles %s during startup without installing subscriptions or leaking handlers', async signal => {
    const signals = new EventEmitter(); const blocked = gate(); const watch = vi.fn<WatchFactory>();
    const session = runWatchSession(async abortSignal => {
      await blocked.promise;
      return own(startGraphWatch({ repos: [synthetic], excludes: [], signal: abortSignal, update: async () => {}, report: vi.fn(), watch }));
    }, signals);
    signals.emit(signal); blocked.resolve(); expect(await session).toBe(0); expect(watch).not.toHaveBeenCalled();
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('waits for an active update before finishing a signalled session', async () => {
    const signals = new EventEmitter(); const blocked = gate(); let started = false; let finished = false;
    const session = runWatchSession(signal => own(startGraphWatch({ repos: [synthetic], excludes: [], signal,
      update: async () => { started = true; await blocked.promise; }, report: vi.fn(),
      watch: () => ({ close() {} }), census: async () => census([synthetic]), gitDirectories: async () => [],
    })), signals).then(code => { finished = true; return code; });
    await vi.waitFor(() => expect(started).toBe(true)); signals.emit('SIGTERM'); signals.emit('SIGINT');
    await new Promise(resolve => setTimeout(resolve, 20)); expect(finished).toBe(false);
    blocked.resolve(); expect(await session).toBe(0); expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('receives real recursive source events and index-only staging events', async () => {
    const f = fixture(); let runs = 0;
    await own(startGraphWatch({ repos: [f.repo], excludes: [], update: async () => { runs++; }, report: vi.fn(), debounceMs: 20, intervalMs: 50 }));
    await vi.waitFor(() => expect(runs).toBeGreaterThan(0), { timeout: 8000 });
    let before = runs; fs.writeFileSync(f.file('a.ts'), 'changed');
    await vi.waitFor(() => expect(runs).toBeGreaterThan(before), { timeout: 8000 });
    fs.writeFileSync(f.file('new.ts'), 'new'); await new Promise(resolve => setTimeout(resolve, 250));
    before = runs; f.git('add', 'new.ts');
    await vi.waitFor(() => expect(runs).toBeGreaterThan(before), { timeout: 8000 });
  });
});
